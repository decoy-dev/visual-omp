/**
 * Pure read-outs of a chat's transcript for the dock: the latest todo checklist, background shell
 * jobs, dev-server URLs printed by commands, and the images and files omp made. Tolerant of
 * partial/unknown shapes, since everything here comes from omp's JSON over the wire.
 */
import type { SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { ActiveTool } from "../../collab/lib/client";
import { resolveToolCall } from "../../chat/friendly";
import { isRecord, str } from "../../tool-render/util";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoTask {
	content: string;
	status: TodoStatus;
}

export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

export type JobState = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundJob {
	jobId: string;
	command: string;
	state: JobState;
	/** Last output omp saw for this job (start preview or final result). */
	output: string;
}

type TranscriptItem =
	| { kind: "result"; name: string; args: Record<string, unknown>; details: Record<string, unknown> | null; message: ToolResultMessage }
	| { kind: "custom"; customType: string; details: unknown };

function resultText(message: ToolResultMessage): string {
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Tool results paired with their calls (normalized like the transcript: `write` → `xd://<tool>`
 * device calls become the device tool, with the device's own details) and custom messages, in order.
 */
function transcriptItems(entries: readonly SessionEntry[]): TranscriptItem[] {
	const calls = new Map<string, { name: string; args: unknown }>();
	const items: TranscriptItem[] = [];
	for (const entry of entries) {
		if (entry.type === "custom_message") {
			items.push({ kind: "custom", customType: entry.customType, details: entry.details });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, { name: block.name, args: block.arguments });
			continue;
		}
		if (message.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId);
		const view = resolveToolCall({
			name: call?.name ?? message.toolName,
			args: call?.args ?? {},
			result: { content: message.content, details: message.details, isError: message.isError },
			running: false,
		});
		const details = view.result?.details;
		items.push({ kind: "result", name: view.name, args: view.args, details: isRecord(details) ? details : null, message });
	}
	return items;
}

const TODO_STATUSES: Record<TodoStatus, true> = { pending: true, in_progress: true, completed: true, abandoned: true };

function isTodoStatus(value: string): value is TodoStatus {
	return Object.hasOwn(TODO_STATUSES, value);
}

function parsePhases(raw: unknown[]): TodoPhase[] {
	const phases: TodoPhase[] = [];
	for (const phase of raw) {
		if (!isRecord(phase)) continue;
		const tasks: TodoTask[] = [];
		if (Array.isArray(phase.tasks)) {
			for (const task of phase.tasks) {
				if (!isRecord(task)) continue;
				const status = str(task.status) ?? "pending";
				tasks.push({
					content: str(task.content) ?? "",
					status: isTodoStatus(status) ? status : "pending",
				});
			}
		}
		phases.push({ name: str(phase.name) ?? "", tasks });
	}
	return phases;
}

/** Phases from the newest successful `todo` result; null when omp never made a checklist. */
export function latestTodo(entries: readonly SessionEntry[]): TodoPhase[] | null {
	const items = transcriptItems(entries);
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind !== "result" || item.name !== "todo" || item.message.isError) continue;
		if (Array.isArray(item.details?.phases)) return parsePhases(item.details.phases);
	}
	return null;
}

const JOB_STATES: Record<JobState, true> = { running: true, completed: true, failed: true, cancelled: true };

function isJobState(value: unknown): value is JobState {
	return typeof value === "string" && Object.hasOwn(JOB_STATES, value);
}

/**
 * Background shell jobs: `bash` calls that went async (details.async), updated by `job` poll/cancel
 * results and closed by omp's `async-result` delivery messages. Newest first.
 */
export function backgroundJobs(
	entries: readonly SessionEntry[],
	activeTools?: ReadonlyMap<string, ActiveTool>,
): BackgroundJob[] {
	const jobs = new Map<string, BackgroundJob>();
	const upsert = (jobId: string, patch: Partial<BackgroundJob>) => {
		const existing: BackgroundJob = jobs.get(jobId) ?? { jobId, command: "", state: "running", output: "" };
		jobs.set(jobId, { ...existing, ...patch });
	};
	for (const item of transcriptItems(entries)) {
		if (item.kind === "custom") {
			if (item.customType !== "async-result" || !isRecord(item.details)) continue;
			const list = Array.isArray(item.details.jobs) ? item.details.jobs : [item.details];
			for (const job of list) {
				const jobId = isRecord(job) ? str(job.jobId) : null;
				// A delivered result means the job ended; `job` polls may refine completed vs failed.
				if (jobId && jobs.get(jobId)?.state === "running") upsert(jobId, { state: "completed" });
			}
			continue;
		}
		const { name, details, args, message } = item;
		if (name === "bash" && details && isRecord(details.async)) {
			const jobId = str(details.async.jobId);
			const state = details.async.state;
			if (jobId && isJobState(state)) upsert(jobId, { command: str(args.command) ?? "", state, output: resultText(message) });
		} else if (name === "job" && details && Array.isArray(details.jobs)) {
			for (const job of details.jobs) {
				if (!isRecord(job)) continue;
				const jobId = str(job.id);
				const state = job.status;
				if (!jobId || !isJobState(state) || !jobs.has(jobId)) continue;
				const text = str(job.resultText) || str(job.errorText);
				upsert(jobId, { state, ...(text ? { output: text } : {}) });
			}
		}
	}
	for (const tool of activeTools?.values() ?? []) {
		// Only calls the model sent to the background; a foreground wait also runs as a managed job.
		if (!isRecord(tool.args) || tool.args.async !== true) continue;
		const partial = isRecord(tool.partialResult) ? tool.partialResult : null;
		const details = partial && isRecord(partial.details) ? partial.details : null;
		const jobId = details && isRecord(details.async) ? str(details.async.jobId) : null;
		if (!jobId) continue;
		const output = details ? str(details.output) : null;
		upsert(jobId, {
			command: str(tool.args.command) ?? "",
			state: "running",
			...(output ? { output } : {}),
		});
	}
	return [...jobs.values()].reverse();
}

const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"'`<>)\]]*)?/gi;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal color codes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Normalizes a printed dev-server URL: 0.0.0.0 / [::] → localhost, trailing punctuation dropped. */
export function normalizeLocalUrl(raw: string): string {
	return raw
		.replace(/[.,;:]+$/, "")
		.replace(/\/\/(?:0\.0\.0\.0|\[::1?\])/, "//localhost")
		.replace(/\/$/, "");
}

/** Local dev-server URLs printed by commands, newest first, deduplicated. */
export function devServerUrls(entries: readonly SessionEntry[], activeTools?: ReadonlyMap<string, ActiveTool>): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult") texts.push(resultText(entry.message));
		else if (entry.type === "message" && entry.message.role === "assistant") {
			for (const block of entry.message.content) if (block.type === "text") texts.push(block.text);
		}
	}
	for (const tool of activeTools?.values() ?? []) {
		const partial = isRecord(tool.partialResult) ? tool.partialResult : null;
		if (partial && Array.isArray(partial.content)) {
			for (const block of partial.content) if (isRecord(block)) texts.push(str(block.text) ?? "");
		}
	}
	const seen = new Set<string>();
	const urls: string[] = [];
	for (let i = texts.length - 1; i >= 0; i--) {
		for (const match of texts[i].replace(ANSI, "").matchAll(LOCAL_URL)) {
			const url = normalizeLocalUrl(match[0]);
			if (!seen.has(url)) {
				seen.add(url);
				urls.push(url);
			}
		}
	}
	return urls;
}

// ── outputs ─────────────────────────────────────────────────────────────────────────────────────

/** Image files the Files viewer and Outputs pane show from disk (main's `panes:readFile` image types). */
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
/** Images main will open in the default app (`panes:openImage` also checks the bytes); SVG stays in-app. */
export const RASTER_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;

/** Image data in a tool result: base64 (the live stream may have cut it short) or a saved session's blob id. */
export type InlineImage = { kind: "data"; mimeType: string; data: string } | { kind: "blob"; hash: string };

export interface ChatOutput {
	/** The path for files and image files, else `<toolCallId>#<n>` (one item per image without a file). */
	key: string;
	kind: "image" | "file";
	/** Absolute path, when the tool named one. */
	path: string | null;
	/** Tool that made or showed it: `read`, `write`, `edit`, `ast_edit`, `generate_image`, `browser`, `eval`… */
	tool: string;
	/** Epoch ms of the tool result. */
	time: number;
	/** Image data carried in the result; null for files and for images known only by path. */
	inline: InlineImage | null;
}

export interface OutputContext {
	/** The chat's working directory, for relative paths. */
	cwd: string | null;
	/** The home folder, for `~/` paths. */
	home: string | null;
}

/** How saved sessions store image data: an id in omp's blob store (`<agentDir>/blobs/<hash>`). */
const BLOB_REF = /^blob:sha256:([0-9a-f]{64})$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\)/i;
/** `read` selectors after the path: `:50-100`, `:raw`, `:img`, `:conflicts`, video times like `:1h5m42s`. */
const READ_SELECTOR = /(?::(?:raw|img|conflicts|[\d,+\-hms]+))+$/;

/** Base64 that arrived whole: omp's live stream head-truncates long strings and appends an elision note. */
export function isIntactBase64(data: string): boolean {
	return data.length > 0 && data.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(data);
}

/** Absolute form of a path a tool named; null for URLs, omp's internal addresses, or a base that is not known yet. */
export function resolveOutputPath(raw: string, context: OutputContext): string | null {
	const path = raw.trim();
	if (!path || URL_SCHEME.test(path)) return null;
	if (path === "~" || path.startsWith("~/")) return context.home ? context.home.replace(/[\\/]+$/, "") + path.slice(1) : null;
	if (path.startsWith("/") || WINDOWS_ABSOLUTE.test(path)) return path;
	return context.cwd ? `${context.cwd.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}` : null;
}

function inlineImage(value: unknown): InlineImage | null {
	if (!isRecord(value)) return null;
	const data = str(value.data);
	const mimeType = str(value.mimeType);
	if (!data || !mimeType) return null;
	const blob = BLOB_REF.exec(data);
	return blob ? { kind: "blob", hash: blob[1] } : { kind: "data", mimeType, data };
}

/** The file a `read` showed: omp's resolved source, else the argument without its selector. */
function readPath(details: Record<string, unknown> | null, args: Record<string, unknown>): string | null {
	const source = details && isRecord(details.meta) && isRecord(details.meta.source) ? details.meta.source : null;
	return (source?.type === "path" ? str(source.value) : null) ?? str(details?.resolvedPath) ?? str(args.path)?.replace(READ_SELECTOR, "") ?? null;
}

/** Files an `edit` changed: each successful `perFileResults` entry, else the single `path`. */
function editPaths(details: Record<string, unknown> | null, args: Record<string, unknown>): string[] {
	const perFile = Array.isArray(details?.perFileResults) ? details.perFileResults.filter(isRecord) : [];
	if (perFile.length > 0) return perFile.flatMap(file => (file.isError === true ? [] : (str(file.path) ?? [])));
	const single = str(details?.path) ?? str(args.path) ?? str(args.file_path);
	return single ? [single] : [];
}

function astEditPaths(details: Record<string, unknown> | null): string[] {
	const files = Array.isArray(details?.fileReplacements) ? details.fileReplacements : [];
	return files.flatMap(file => (isRecord(file) ? (str(file.path) ?? []) : []));
}

/**
 * Images and files omp made or showed in a chat, newest first: image blocks in tool results (with the `read`
 * path when there is one), `generate_image` results paired with their saved paths, and files written or
 * changed by `write`, `edit` and `ast_edit` (a staged `ast_edit` preview counts once `resolve` applies it).
 * A path appears once, at its newest use; images without a path are separate items.
 */
export function chatOutputs(entries: readonly SessionEntry[], context: OutputContext): ChatOutput[] {
	const outputs = new Map<string, ChatOutput>();
	const add = (output: ChatOutput) => {
		outputs.delete(output.key);
		outputs.set(output.key, output);
	};
	const addFile = (raw: string, tool: string, time: number, base: OutputContext) => {
		const path = resolveOutputPath(raw, base);
		if (path) add({ key: path, kind: IMAGE_EXT.test(path) ? "image" : "file", path, tool, time, inline: null });
	};
	let staged: { paths: string[]; base: OutputContext } | null = null;
	for (const item of transcriptItems(entries)) {
		if (item.kind !== "result") continue;
		const { name, args, details, message } = item;
		const time = message.timestamp;
		// Null keeps a details image whose data is unreadable aligned with its saved path.
		const images: (InlineImage | null)[] = [];
		let paths: (string | null)[] = [];
		if (name === "generate_image" && details) {
			// Generated images travel in details (out of model context); `imagePaths[i]` is where image i was saved.
			if (Array.isArray(details.images)) for (const image of details.images) images.push(inlineImage(image));
			if (Array.isArray(details.imagePaths)) paths = details.imagePaths.map(path => (typeof path === "string" ? resolveOutputPath(path, context) : null));
		}
		for (const block of message.content) if (block.type === "image") images.push(inlineImage(block));
		if (name === "read" && images.length === 1) {
			const raw = readPath(details, args);
			paths = [raw ? resolveOutputPath(raw, context) : null];
		}
		for (let n = 0; n < Math.max(images.length, paths.length); n++) {
			const inline = images[n] ?? null;
			const path = paths[n] ?? null;
			if (!inline && !path) continue;
			// A video frame or PDF page shares its file's path, so only image files merge by path.
			add({ key: path && IMAGE_EXT.test(path) ? path : `${message.toolCallId}#${n}`, kind: "image", path, tool: name, time, inline });
		}
		if (message.isError) continue;
		if (name === "write") {
			const raw = str(details?.resolvedPath) ?? str(args.path);
			if (raw) addFile(raw, "write", time, context);
		} else if (name === "edit") {
			for (const raw of editPaths(details, args)) addFile(raw, "edit", time, context);
		} else if (name === "ast_edit") {
			const base = { ...context, cwd: str(details?.cwd) ?? context.cwd };
			if (details?.applied === false) staged = { paths: astEditPaths(details), base };
			else for (const raw of astEditPaths(details)) addFile(raw, "ast_edit", time, base);
		} else if (name === "resolve" || name === "reject") {
			const action = str(details?.action) ?? str(args.action) ?? (name === "reject" ? "discard" : "apply");
			const source = str(details?.sourceToolName) ?? "ast_edit";
			if (staged && action === "apply" && source === "ast_edit") for (const raw of staged.paths) addFile(raw, "ast_edit", time, staged.base);
			staged = null;
		}
	}
	return [...outputs.values()].reverse();
}
