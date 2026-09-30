/**
 * Pure read-outs of a chat's transcript for the dock: the latest todo checklist, background shell
 * jobs, and dev-server URLs printed by commands. Tolerant of partial/unknown shapes — everything
 * here comes from omp's JSON over the wire.
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
