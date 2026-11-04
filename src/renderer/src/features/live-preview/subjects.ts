import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { PreviewChange } from "@shared/contracts/preview";
import { resolveToolCall } from "../../chat/friendly";
import type { ActiveTool } from "../../collab/lib/client";
import { isRecord, resultTextOf, str } from "../../tool-render/util";
import { commandPaths, IMAGE_EXT, isIntactBase64, resolveOutputPath } from "../panes/derive";
import type { LiveFormat, LiveImage, LiveRequest, LiveSubject, LiveSubjectState } from "./types";

export interface SubjectInput {
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	backgroundTools: ReadonlyMap<string, ActiveTool>;
	entries: readonly SessionEntry[];
	changes: readonly PreviewChange[];
	working: boolean;
	folder: string | null;
	now: number;
}

interface Call {
	id: string;
	name: string;
	args: Record<string, unknown>;
	intent: string | null;
	start: number;
	end: number | null;
	streaming: boolean;
	aborted: boolean;
	active: boolean;
	result?: ToolResultMessage;
	partial?: unknown;
}

const ELIDED = /…\[\d+ chars elided for collab session\]/;

function sourceFormat(path: string): LiveFormat | null {
	if (/\.svg$/i.test(path)) return "svg";
	if (/\.(?:mmd|mermaid)$/i.test(path)) return "mermaid";
	if (/\.html?$/i.test(path)) return "html";
	if (/\.(?:md|markdown)$/i.test(path)) return "markdown";
	if (/\.(?:csv|tsv)$/i.test(path)) return "csv";
	return null;
}

function fileFormat(path: string): LiveFormat | null {
	if (/\.svg$/i.test(path)) return "svg";
	if (IMAGE_EXT.test(path)) return "image";
	if (/\.pdf$/i.test(path)) return "pdf";
	if (/\.html?$/i.test(path)) return "html";
	return null;
}

/** Device calls have the same identity and argument shape as their transcript card. */
export function isVisualCall(toolName: string, args: unknown): boolean {
	const call = resolveToolCall({ name: toolName, args, running: true });
	return call.name === "generate_image" || call.name === "eval" || (call.name === "write" && sourceFormat(str(call.args.path ?? call.args.file_path) ?? "") !== null);
}

function turnStart(input: SubjectInput): { index: number; time: number } {
	for (let index = input.entries.length - 1; index >= 0; index--) {
		const entry = input.entries[index];
		if ((entry.type === "message" && entry.message.role === "user") || (entry.type === "custom_message" && entry.customType === "collab-prompt")) {
			return { index: index + 1, time: entry.type === "message" ? entry.message.timestamp : Date.parse(entry.timestamp) };
		}
	}
	return { index: 0, time: 0 };
}

function callsOf(input: SubjectInput): Call[] {
	const turn = turnStart(input);
	const calls = new Map<string, Call>();
	const starts = new Map<string, number>();
	const add = (message: AssistantMessage, streaming: boolean) => {
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const old = calls.get(block.id);
			const view = resolveToolCall({ name: block.name, args: block.arguments, intent: block.intent, running: true });
			calls.set(block.id, { ...old, id: block.id, name: view.name, args: view.args, intent: view.intent ?? null, start: old?.start ?? message.timestamp, end: old?.end ?? null, streaming, aborted: message.stopReason === "aborted" || message.stopReason === "error", active: old?.active ?? false });
		}
	};
	for (const entry of input.entries.slice(turn.index)) {
		if ((entry.type as string) === "custom") {
			const record = entry as unknown as { customType: string; data: unknown };
			if (record.customType === "tool_execution_start" && isRecord(record.data) && typeof record.data.toolCallId === "string") {
				starts.set(record.data.toolCallId, Date.parse(str(record.data.startedAt) ?? entry.timestamp));
			}
		} else if (entry.type === "message" && entry.message.role === "assistant") add(entry.message, false);
	}
	if (input.stream && input.stream.timestamp >= turn.time) add(input.stream, !input.streamDone);
	for (const live of [...input.backgroundTools.values(), ...input.activeTools.values()]) {
		const old = calls.get(live.toolCallId);
		if (!old && live.startedAt < turn.time) continue;
		const view = resolveToolCall({ name: live.toolName, args: live.args, intent: live.intent, running: true });
		calls.set(live.toolCallId, { ...old, id: live.toolCallId, name: view.name, args: view.args, intent: view.intent ?? old?.intent ?? null, start: live.startedAt, end: null, streaming: false, aborted: false, active: true, partial: live.partialResult });
	}
	for (const entry of input.entries.slice(turn.index)) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const call = calls.get(entry.message.toolCallId);
		if (!call) continue;
		call.result = entry.message;
		call.end = entry.message.timestamp;
		call.start = starts.get(call.id) ?? call.start;
		// Background updates can continue after the initial tool result.
		if (!input.backgroundTools.has(call.id)) call.active = false;
	}
	return [...calls.values()];
}

function pathsOf(call: Call, input: SubjectInput): string[] {
	const context = { cwd: input.folder, home: null };
	const partial = isRecord(call.partial) && Array.isArray(call.partial.content) ? call.partial.content.filter(isRecord).map(block => block.type === "text" ? str(block.text) ?? "" : "").join("\n") : "";
	const paths = commandPaths(call.args, `${partial}\n${resultTextOf(call.result)}`, context);
	const direct = str(call.args.path ?? call.args.file_path);
	const path = direct ? resolveOutputPath(direct, context) : null;
	return path ? [...new Set([path, ...paths])] : paths;
}

/** Paths the turn named, including completed calls, for narrow grants in broad folders. */
export function relatedPaths(input: SubjectInput): string[] {
	return [...new Set(callsOf(input).flatMap(call => pathsOf(call, input)))];
}

/** Only running calls extend the watcher's named scope. */
export function namedPaths(input: SubjectInput): string[] {
	return [...new Set(callsOf(input).filter(call => call.active).flatMap(call => pathsOf(call, input)))];
}

function stateOf(call: Call, working: boolean): LiveSubjectState {
	const details = call.result?.details;
	if (isRecord(details) && details.source === "interrupt_skipped" && (details.__synthetic === true || details.__interrupted === true)) return "skipped";
	if (call.active) return "running";
	if (call.result) return call.result.isError ? "failed" : "saved";
	if (call.aborted || !working) return "stopped";
	return call.streaming ? "writing" : "running";
}

function imagesOf(result: unknown): LiveImage[] {
	if (!isRecord(result)) return [];
	const details = isRecord(result.details) ? result.details : null;
	const blocks: unknown[] = Array.isArray(result.content) ? [...result.content] : [];
	if (Array.isArray(details?.images)) blocks.push(...details.images);
	else if (Array.isArray(details?.cells)) for (const cell of details.cells) {
		if (isRecord(cell) && Array.isArray(cell.displayOutputs)) blocks.push(...cell.displayOutputs);
	}
	const images: LiveImage[] = [];
	for (const block of blocks) {
		if (isRecord(block) && block.type === "image" && typeof block.mimeType === "string" && typeof block.data === "string" && isIntactBase64(block.data) && !images.some(image => image.data === block.data && image.mimeType === block.mimeType)) images.push({ mimeType: block.mimeType, data: block.data });
	}
	return images;
}

function requestOf(args: Record<string, unknown>): LiveRequest {
	const subject = [args.subject, args.action, args.scene].filter(value => typeof value === "string" && value).join(", ");
	const parts = [subject, args.composition, args.lighting, args.style].filter(value => typeof value === "string" && value) as string[];
	let prompt = str(args.prompt) ?? (parts.length ? `${parts.map(part => part.replace(/[.!,;:]+$/, "")).join(". ")}.` : null);
	if (typeof args.text === "string") prompt = `${prompt ?? ""}\n\nText: ${args.text}`;
	if (Array.isArray(args.changes)) prompt = `${prompt ?? ""}\n\nChanges:\n${args.changes.filter(value => typeof value === "string").map(value => `- ${value}`).join("\n")}`;
	return { prompt, model: str(args.model ?? args.provider), size: str(args.image_size ?? args.size), aspectRatio: str(args.aspect_ratio), count: typeof (args.count ?? args.n) === "number" ? (args.count ?? args.n) as number : null };
}

function sameContent(a: LiveSubject, b: LiveSubject): boolean {
	return a.kind === b.kind && a.format === b.format && a.path === b.path && a.text === b.text && a.elided === b.elided && a.size === b.size && (a.kind !== "file" || a.updatedAt === b.updatedAt) && JSON.stringify(a.request) === JSON.stringify(b.request) && JSON.stringify(a.images) === JSON.stringify(b.images);
}

/** Current-turn subjects, newest first. State-only changes preserve the rendered revision. */
export function deriveSubjects(input: SubjectInput, previous: readonly LiveSubject[]): LiveSubject[] {
	const calls = callsOf(input);
	const old = new Map(previous.map(subject => [subject.id, subject]));
	const subjects = new Map<string, LiveSubject>();
	for (const call of calls) {
		const id = `call:${call.id}`;
		const prior = old.get(id);
		const pathArg = str(call.args.path ?? call.args.file_path);
		const path = pathArg ? resolveOutputPath(pathArg, { cwd: input.folder, home: null }) : null;
		const format = call.name === "write" ? sourceFormat(pathArg ?? "") : null;
		const partialImages = imagesOf(call.partial);
		const images = partialImages.length ? partialImages : prior?.kind === "images" || call.name === "eval" || call.name === "generate_image" ? imagesOf(call.result) : [];
		const retainedImages = !images.length && prior?.kind === "images" ? prior.images : null;
		if (!format && call.name !== "generate_image" && !images.length && !retainedImages) continue;
		const text = format ? str(call.args.content) ?? "" : null;
		const kind = format ? "source" : images.length || retainedImages ? "images" : "request";
		subjects.set(id, { id, kind, format: format ?? (kind === "images" ? "result-images" : "generate-image"), toolCallId: call.id, toolName: call.name, path, text, revision: 1, state: stateOf(call, input.working), elided: text !== null && ELIDED.test(text), intent: call.intent, request: kind === "request" ? requestOf(call.args) : null, images: kind === "images" ? (images.length ? images : retainedImages) : null, size: text === null ? null : prior?.text === text ? prior.size : new TextEncoder().encode(text).length, startedAt: prior?.startedAt ?? call.start, updatedAt: input.now });
		const subject = subjects.get(id);
		if (subject?.elided && subject.state === "saved" && subject.path) {
			subjects.set(id, { ...subject, kind: "file", text: null, elided: false, size: null, updatedAt: call.end ?? input.now });
		}
	}
	const turn = turnStart(input);
	for (const change of input.changes) {
		const format = fileFormat(change.path);
		if (!format || change.mtimeMs < turn.time) continue;
		const named = calls.filter(call => call.active && pathsOf(call, input).some(path => change.path === path || change.path.startsWith(`${path.replace(/[\\/]+$/, "")}/`)));
		const owner = named.sort((a, b) => b.start - a.start)[0] ?? calls.filter(call => change.mtimeMs >= call.start && change.mtimeMs <= (call.end ?? input.now)).sort((a, b) => b.start - a.start)[0];
		// The write that streamed this file already shows it, so its save is not a second output. The guest stamps a
		// call's start when collab delivers it, which can be after the file's mtime, so match the write by path.
		const source = [...subjects.values()].find(subject => subject.path === change.path && (subject.kind === "source" || (subject.kind === "file" && subject.id.startsWith("call:"))));
		if (source && (!owner || owner.id === source.toolCallId)) {
			if (source.kind === "source" && !source.elided) continue;
			subjects.set(source.id, { ...source, kind: "file", text: null, elided: false, size: change.size, updatedAt: source.kind === "file" ? Math.max(source.updatedAt, change.mtimeMs) : change.mtimeMs });
			continue;
		}
		const id = `file:${change.path}`;
		const existing = subjects.get(id);
		if (existing && existing.updatedAt > change.mtimeMs) continue;
		const prior = old.get(id);
		subjects.set(id, { id, kind: "file", format, toolCallId: owner?.id ?? null, toolName: owner?.name ?? null, path: change.path, text: null, revision: 1, state: owner ? stateOf(owner, input.working) : input.working ? "running" : "saved", elided: false, intent: owner?.intent ?? null, request: null, images: null, size: change.size, startedAt: prior?.startedAt ?? change.mtimeMs, updatedAt: change.mtimeMs });
	}
	// An aborted stream can disappear before its committed entry arrives.
	for (const prior of previous) if (!subjects.has(prior.id) && prior.startedAt >= turn.time && !calls.some(call => call.id === prior.toolCallId) && prior.kind !== "file") subjects.set(prior.id, { ...prior, state: "stopped" });
	return [...subjects.values()].map(subject => {
		const prior = old.get(subject.id);
		if (!prior) return subject;
		const same = sameContent(prior, subject);
		return { ...subject, revision: prior.revision + (same ? 0 : 1), updatedAt: same ? prior.updatedAt : subject.updatedAt };
	}).sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
}
