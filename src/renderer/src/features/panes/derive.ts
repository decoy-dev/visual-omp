/**
 * Pure read-outs of a chat's transcript for the dock and the chat: the todo checklist and its updates, background
 * shell jobs, dev-server URLs printed by commands, the images and files omp made, the files each call changed, plan
 * checkbox steps, and helpers at work. Tolerant of partial/unknown shapes, since everything here comes from omp's
 * JSON over the wire.
 */
import type { AgentProgress, AgentSnapshot, SessionEntry, SubagentLifecyclePayload, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { PaneMadeFile, PaneMadeQuery } from "@shared/contracts/panes";
import type { ActiveTool, GuestSnapshot } from "../../collab/lib/client";
import { resolveToolCall } from "../../chat/friendly";
import { type JobStatus, parseNotice } from "../../chat/transcript/notices";
import type { SessionView } from "../../state/session";
import { isRecord, num, str } from "../../tool-render/util";

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
	/** What the model said the command is for (the call's `i` intent), the row's title; null for calls without one. */
	intent: string | null;
	state: JobState;
	/** Last output omp saw for this job (start preview, poll snapshot or final result). */
	output: string;
	/** Epoch ms the call started; null when unknown. */
	startedAt: number | null;
	/** omp's own run time from a delivery or job snapshot, once settled; null while running or when omp gave none. */
	durationMs: number | null;
	/** The shell's exit code when the output reports one ("Command exited with code N"). */
	exitCode: number | null;
}

type TranscriptItem =
	| {
			kind: "result";
			name: string;
			args: Record<string, unknown>;
			details: Record<string, unknown> | null;
			message: ToolResultMessage;
			/** Epoch ms the call started, never after the result; the result time when unknown. */
			start: number;
			/** The call's intent (omp's `i` argument), when the model gave one. */
			intent: string | null;
	  }
	| { kind: "custom"; customType: string; details: unknown; time: number; entry: Extract<SessionEntry, { type: "custom_message" }> }
	/**
	 * omp's `session_exit` record (`AgentSession.#recordSessionExit` in session/agent-session.ts, written on normal and
	 * fatal teardown): the omp process that wrote the entries before it has ended, and its helpers and jobs with it.
	 * A crash that skips teardown writes none.
	 */
	| { kind: "exit" };

function resultText(message: ToolResultMessage): string {
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/** When a call started: omp's `tool_execution_start` entry (saved sessions only) or the assistant message that made it. */
function startTime(recorded: number | undefined, called: number | undefined, end: number): number {
	for (const time of [recorded, called]) if (time !== undefined && Number.isFinite(time) && time > 0 && time <= end) return time;
	return end;
}

/** A call's intent: omp records it on the call, and the model sends it as the `i` argument. */
function callIntent(call: { intent?: string; arguments?: unknown }): string | null {
	const intent = call.intent ?? (isRecord(call.arguments) ? str(call.arguments.i) : null);
	return intent?.trim() || null;
}

/**
 * Tool results paired with their calls (normalized like the transcript: `write` → `xd://<tool>`
 * device calls become the device tool, with the device's own details) and custom messages, in order.
 * A call id counts once: a reconnect can deliver the same result again.
 */
function transcriptItems(entries: readonly SessionEntry[]): TranscriptItem[] {
	const calls = new Map<string, { name: string; args: unknown; time: number; intent: string | null }>();
	const starts = new Map<string, number>();
	const answered = new Set<string>();
	const items: TranscriptItem[] = [];
	for (const entry of entries) {
		// Saved sessions also hold omp's `custom` bookkeeping entries, which the wire types leave out.
		const type: string = entry.type;
		if (type === "custom") {
			const { customType, data } = entry as unknown as { customType?: unknown; data?: unknown };
			if (customType === "session_exit") items.push({ kind: "exit" });
			const id = customType === "tool_execution_start" && isRecord(data) ? str(data.toolCallId) : null;
			if (id && isRecord(data)) starts.set(id, Date.parse(str(data.startedAt) ?? entry.timestamp));
			continue;
		}
		if (entry.type === "custom_message") {
			items.push({ kind: "custom", customType: entry.customType, details: entry.details, time: Date.parse(entry.timestamp), entry });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") calls.set(block.id, { name: block.name, args: block.arguments, time: message.timestamp, intent: callIntent(block) });
			}
			continue;
		}
		if (message.role !== "toolResult" || answered.has(message.toolCallId)) continue;
		answered.add(message.toolCallId);
		const call = calls.get(message.toolCallId);
		const view = resolveToolCall({
			name: call?.name ?? message.toolName,
			args: call?.args ?? {},
			result: { content: message.content, details: message.details, isError: message.isError },
			running: false,
		});
		const details = view.result?.details;
		const start = startTime(starts.get(message.toolCallId), call?.time, message.timestamp);
		items.push({ kind: "result", name: view.name, args: view.args, details: isRecord(details) ? details : null, message, start, intent: call?.intent ?? null });
	}
	return items;
}

const TODO_STATUSES: Record<TodoStatus, true> = { pending: true, in_progress: true, completed: true, abandoned: true };

function isTodoStatus(value: string): value is TodoStatus {
	return Object.hasOwn(TODO_STATUSES, value);
}

/** A `todo` result's `details.phases`, with unknown statuses read as pending. */
export function parsePhases(raw: unknown[]): TodoPhase[] {
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
	const updates = todoUpdates(entries);
	return updates.at(-1)?.phases ?? null;
}

export interface TodoUpdate {
	/** The `todo` call's id. */
	callId: string;
	phases: TodoPhase[];
	/** The board before this update; null for the chat's first board. */
	previous: TodoPhase[] | null;
}

/** Every successful `todo` result that carries a board, oldest first, each with the board it replaced. */
export function todoUpdates(entries: readonly SessionEntry[]): TodoUpdate[] {
	const updates: TodoUpdate[] = [];
	for (const item of transcriptItems(entries)) {
		if (item.kind !== "result" || item.name !== "todo" || item.message.isError || !Array.isArray(item.details?.phases)) continue;
		updates.push({ callId: item.message.toolCallId, phases: parsePhases(item.details.phases), previous: updates.at(-1)?.phases ?? null });
	}
	return updates;
}

export interface TodoCounts {
	done: number;
	total: number;
	abandoned: number;
}

/** Completed of all tasks; abandoned tasks count apart and stay out of the total, since nobody will finish them. */
export function todoCounts(phases: readonly TodoPhase[]): TodoCounts {
	let done = 0;
	let total = 0;
	let abandoned = 0;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "abandoned") abandoned++;
			else {
				total++;
				if (task.status === "completed") done++;
			}
		}
	}
	return { done, total, abandoned };
}

export type TodoChangeKind = "completed" | "started" | "abandoned" | "reopened" | "added" | "removed";

export interface TodoChange {
	kind: TodoChangeKind;
	task: string;
}

const CHANGE_ORDER: Record<TodoChangeKind, number> = { completed: 0, started: 1, abandoned: 2, reopened: 3, added: 4, removed: 5 };

/**
 * What one board update changed, matched by task text (repeats pair up in order): status moves, then new and dropped
 * tasks. Ordered by kind, then board order.
 */
export function todoChanges(previous: readonly TodoPhase[] | null, next: readonly TodoPhase[]): TodoChange[] {
	const before = new Map<string, TodoStatus[]>();
	for (const task of previous?.flatMap(phase => phase.tasks) ?? []) before.set(task.content, [...(before.get(task.content) ?? []), task.status]);
	const changes: TodoChange[] = [];
	for (const task of next.flatMap(phase => phase.tasks)) {
		const statuses = before.get(task.content);
		const was = statuses?.shift();
		if (was === undefined) {
			changes.push({ kind: "added", task: task.content });
			continue;
		}
		if (was === task.status) continue;
		if (task.status === "completed") changes.push({ kind: "completed", task: task.content });
		else if (task.status === "in_progress") changes.push({ kind: "started", task: task.content });
		else if (task.status === "abandoned") changes.push({ kind: "abandoned", task: task.content });
		else changes.push({ kind: "reopened", task: task.content });
	}
	for (const [task, statuses] of before) for (let n = 0; n < statuses.length; n++) changes.push({ kind: "removed", task });
	return changes.map((change, index) => ({ change, index })).sort((a, b) => CHANGE_ORDER[a.change.kind] - CHANGE_ORDER[b.change.kind] || a.index - b.index).map(({ change }) => change);
}

const JOB_STATES: Record<JobState, true> = { running: true, completed: true, failed: true, cancelled: true };

function isJobState(value: unknown): value is JobState {
	return typeof value === "string" && Object.hasOwn(JOB_STATES, value);
}

/** A delivered result's outcome (chat/transcript/notices.ts reads it from omp's `<task-result status>` or exit line). */
const DELIVERED_STATE: Record<JobStatus, JobState> = { ok: "completed", failed: "failed", stopped: "cancelled" };

/** One background job's state as one transcript item reports it. `label` is the command, or the helper's id for a task job. */
interface JobReport {
	id: string;
	type: string | null;
	label: string | null;
	state: JobState;
	output: string | null;
	/** omp's run time for the job, when the report carries one. */
	durationMs: number | null;
	/** An `async-result` delivery, which ends the job; snapshots may say it still runs. */
	delivered: boolean;
}

/** Job states an item reports: omp's `async-result` deliveries and the job lists of `job` polls and `wait` results. */
function jobReports(item: TranscriptItem): JobReport[] {
	if (item.kind === "custom") {
		if (item.customType !== "async-result") return [];
		const notice = parseNotice(item.entry);
		if (notice.kind !== "jobs") return [];
		return notice.jobs.map(job => ({
			id: job.id,
			type: job.type,
			label: job.label,
			state: DELIVERED_STATE[job.status],
			output: job.result,
			durationMs: job.durationMs,
			delivered: true,
		}));
	}
	if (item.kind !== "result" || (item.name !== "job" && item.name !== "wait") || !Array.isArray(item.details?.jobs)) return [];
	return item.details.jobs.flatMap((job): JobReport[] => {
		if (!isRecord(job)) return [];
		const id = str(job.id);
		const state = job.status;
		if (!id || !isJobState(state)) return [];
		const durationMs = num(job.durationMs);
		return [
			{
				id,
				type: str(job.type),
				label: str(job.agentUrlId) ?? str(job.label),
				state,
				output: str(job.resultText) || str(job.errorText),
				durationMs: durationMs !== null && durationMs >= 0 ? durationMs : null,
				delivered: false,
			},
		];
	});
}

/** omp's closing line for a shell command that failed (`Command exited with code N`). */
const EXIT_LINE = /(?:^|\n)Command exited with code (-?\d+)\s*$/;

function exitCodeOf(output: string): number | null {
	const code = EXIT_LINE.exec(output.trimEnd())?.[1];
	return code === undefined ? null : Number(code);
}

/**
 * Background shell jobs: `bash` calls that went async (details.async), updated by `job` and `wait` results and closed
 * by omp's `async-result` deliveries. A job omp never reported finished before its process ended (a `session_exit`
 * record, or no omp running this chat now) shows as cancelled. Running jobs come first, then the rest; newest first
 * within each, as omp's `/jobs` lists them.
 */
export function backgroundJobs(entries: readonly SessionEntry[], ompLive: boolean, activeTools?: ReadonlyMap<string, ActiveTool>): BackgroundJob[] {
	const jobs = new Map<string, BackgroundJob>();
	const upsert = (jobId: string, patch: Partial<BackgroundJob>) => {
		const existing: BackgroundJob = jobs.get(jobId) ?? {
			jobId,
			command: "",
			intent: null,
			state: "running",
			output: "",
			startedAt: null,
			durationMs: null,
			exitCode: null,
		};
		jobs.set(jobId, { ...existing, ...patch });
	};
	const stopRunning = () => {
		for (const job of jobs.values()) if (job.state === "running") upsert(job.jobId, { state: "cancelled" });
	};
	for (const item of transcriptItems(entries)) {
		if (item.kind === "exit") {
			stopRunning();
			continue;
		}
		if (item.kind === "result" && item.name === "bash" && item.details && isRecord(item.details.async)) {
			const jobId = str(item.details.async.jobId);
			const state = item.details.async.state;
			if (jobId && isJobState(state)) {
				upsert(jobId, { command: str(item.args.command) ?? "", intent: item.intent, state, output: resultText(item.message), startedAt: item.start });
			}
			continue;
		}
		for (const report of jobReports(item)) {
			const job = jobs.get(report.id);
			if (!job) continue;
			// A delivery ends a running job. When a poll already said how it ended, that outcome stands, but the
			// delivery still brings the final output, omp's run time and the exit line.
			const state = report.delivered && job.state !== "running" ? job.state : report.state;
			const output = report.output ?? job.output;
			upsert(report.id, {
				state,
				output,
				...(state !== "running" ? { durationMs: report.durationMs ?? job.durationMs, exitCode: exitCodeOf(output) ?? job.exitCode } : {}),
			});
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
			intent: callIntent({ intent: tool.intent, arguments: tool.args }),
			state: "running",
			startedAt: tool.startedAt,
			...(output ? { output } : {}),
		});
	}
	if (!ompLive) stopRunning();
	const newestFirst = [...jobs.values()].reverse();
	return [...newestFirst.filter(job => job.state === "running"), ...newestFirst.filter(job => job.state !== "running")];
}

/** Shell setup and chatter a summary skips: `set -e`, `cd dir`, `export X=1`, `X=$(…)`, `sleep 10`, `echo …`, comments. */
const SETUP_STEP =
	/^(?:set\s+[-+]\w+|cd\s+\S+|export\s+\S+|sleep\s+\S+|(?:echo|printf)\b[\s\S]*|true|:|[A-Za-z_][A-Za-z0-9_]*=(?:\$\([\s\S]*\)|"[^"]*"|'[^']*'|\S*)|#[\s\S]*)$/;

/**
 * A command's top-level steps, split at `;`, newlines, `&&` and `||` outside quotes, backticks, `(…)` and `$(…)`,
 * with here-document bodies left out. Null when the quoting does not balance, so no fragment is taken for a step.
 */
function shellSteps(command: string): string[] | null {
	const steps: string[] = [];
	const stack: ("'" | '"' | "`" | "(")[] = [];
	let step = "";
	/** An open here-document: its marker, and whether `<<-` lets the closing line start with tabs. */
	let heredoc: { marker: string; tabs: boolean } | null = null;
	const end = () => {
		if (step.trim()) steps.push(step.trim());
		step = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] ?? "";
		const top = stack.at(-1);
		if (top === "'") {
			if (ch === "'") stack.pop();
			step += ch;
			continue;
		}
		if (ch === "\\") {
			step += command.slice(i, i + 2);
			i++;
			continue;
		}
		if (top === '"' || top === "`") {
			if (ch === top) stack.pop();
			else if (top === '"' && ch === "$" && command[i + 1] === "(") {
				stack.push("(");
				step += "$(";
				i++;
				continue;
			} else if (top === '"' && ch === "`") stack.push("`");
			step += ch;
			continue;
		}
		// Outside quotes: at the top level or inside (…) / $(…).
		if (ch === "#" && /(^|[\s;(])$/.test(step.slice(-1) || " ")) {
			const newline = command.indexOf("\n", i);
			i = (newline === -1 ? command.length : newline) - 1;
			continue;
		}
		if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
			const opener = /^<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/.exec(command.slice(i));
			if (opener) {
				heredoc = { marker: opener[3] ?? "", tabs: opener[1] === "-" };
				step += opener[0];
				i += opener[0].length - 1;
				continue;
			}
		}
		if (ch === "'" || ch === '"' || ch === "`" || ch === "(") stack.push(ch);
		else if (ch === ")") {
			if (top !== "(") return null;
			stack.pop();
		}
		if (stack.length === 0 && ch === "\n" && heredoc !== null) {
			// Skip the body through the line that is exactly the marker (after leading tabs, for `<<-`).
			let at = i + 1;
			let closed = -1;
			while (at <= command.length) {
				const lineEnd = command.indexOf("\n", at);
				const line = command.slice(at, lineEnd === -1 ? command.length : lineEnd);
				if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.marker) {
					closed = lineEnd === -1 ? command.length : lineEnd;
					break;
				}
				if (lineEnd === -1) break;
				at = lineEnd + 1;
			}
			if (closed === -1) return null;
			i = closed - 1;
			heredoc = null;
			continue;
		}
		const pair = command.slice(i, i + 2);
		if (stack.length === 0 && (ch === ";" || ch === "\n" || pair === "&&" || pair === "||")) {
			end();
			if (pair === "&&" || pair === "||") i++;
			continue;
		}
		step += ch;
	}
	if (stack.length > 0) return null;
	end();
	return steps;
}

/**
 * A short line for the command under a job's title, and the title itself when the call gave no intent: the first
 * top-level step that does something, skipping shell setup and chatter so rows stop opening on boilerplate. A
 * command whose quoting does not parse falls back to its first line.
 */
export function commandSummary(command: string): string {
	const steps = shellSteps(command);
	const first = steps
		? (steps.find(step => !SETUP_STEP.test(step)) ?? steps[0] ?? "")
		: (command.split("\n").find(line => line.trim()) ?? "").trim();
	const line = first.replace(/\s+/g, " ").trim();
	return line.length > 120 ? `${line.slice(0, 119)}…` : line;
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
export const PDF_EXT = /\.pdf$/i;
/** Files main opens in the default app and thumbnails (`panes:openOutput` also checks the bytes); SVG stays in-app. */
export const OPENABLE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf)$/i;

/** Image data in a tool result: base64 (the live stream may have cut it short) or a saved session's blob id. */
export type InlineImage = { kind: "data"; mimeType: string; data: string } | { kind: "blob"; hash: string };

/** How omp produced an output, for its "Edited 14:32" label. `created`: an `edit` in patch mode that added the file. */
export type OutputAction = "viewed" | "written" | "edited" | "created" | "generated" | "captured" | "made";

/** Actions that create or change the file; `viewed` and `captured` only look at it. */
const PRODUCES: Record<OutputAction, boolean> = { viewed: false, captured: false, written: true, edited: true, created: true, generated: true, made: true };
/**
 * What a chat knows about an output, from the evidence its history carries.
 * - `created`: new for certain. An `edit` in patch mode that reports the `create` operation, or a `generate_image`
 *   result: omp saves each image to a fresh `omp-image-<id>` file in the temp folder, or keeps it inline with no file.
 * - `written`: omp wrote it, or a command left it modified, and nothing earlier in the chat shows it existed. `write`
 *   reports only the path and the bytes, and main's command scan only the modification time, so it may be new or a
 *   replaced file.
 * - `changed`: omp edited it, or wrote it after the chat had read or shown it, so it existed first.
 * - `viewed`: omp only looked at it.
 * The first producing use decides, so a created file stays created when omp edits or views it later.
 */
export type OutputRelation = "created" | "written" | "changed" | "viewed";

/**
 * The relation a producing action gives a file the chat hasn't seen before. An edit without the `create` operation
 * works on text that is already in the file, so the file existed.
 */
const FIRST_PRODUCED: Record<OutputAction, OutputRelation> = {
	viewed: "viewed",
	captured: "viewed",
	created: "created",
	generated: "created",
	written: "written",
	made: "written",
	edited: "changed",
};

export interface ChatOutput {
	/** The path for files, PDFs and image files, else `<toolCallId>#<n>` (one item per image without a file). */
	key: string;
	kind: "image" | "pdf" | "file";
	/** Absolute path, when the tool named one. */
	path: string | null;
	/** Tool that made or showed it: `read`, `write`, `edit`, `ast_edit`, `generate_image`, `bash`, `eval`… */
	tool: string;
	action: OutputAction;
	/** omp made, wrote, generated or edited it in this chat, at this use or an earlier one (a later look keeps it made). */
	produced: boolean;
	relation: OutputRelation;
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

/**
 * Files an `edit` changed: each successful `perFileResults` entry, else the single `path`. `created` is set when patch
 * mode reports the `create` operation, the one place omp says a file is new.
 */
function editPaths(details: Record<string, unknown> | null, args: Record<string, unknown>): { path: string; created: boolean }[] {
	const perFile = Array.isArray(details?.perFileResults) ? details.perFileResults.filter(isRecord) : [];
	if (perFile.length > 0) {
		return perFile.flatMap(file => {
			const path = file.isError === true ? null : str(file.path);
			return path ? [{ path, created: file.op === "create" }] : [];
		});
	}
	const single = str(details?.path) ?? str(args.path) ?? str(args.file_path);
	return single ? [{ path: single, created: details?.op === "create" }] : [];
}

function astEditPaths(details: Record<string, unknown> | null): string[] {
	const files = Array.isArray(details?.fileReplacements) ? details.fileReplacements : [];
	return files.flatMap(file => (isRecord(file) ? (str(file.path) ?? []) : []));
}

function kindOf(path: string): ChatOutput["kind"] {
	return IMAGE_EXT.test(path) ? "image" : PDF_EXT.test(path) ? "pdf" : "file";
}

// ── files made by commands ──────────────────────────────────────────────────────────────────────

/** Tools that can make files without naming them as outputs: shells, notebooks and the browser. */
const COMMAND_TOOLS: Record<string, true> = { bash: true, eval: true, browser: true };
const PATHS_PER_CALL = 32;
/** Text read from each source (head and tail); longer outputs rarely name new paths in the middle. */
const TEXT_HEAD = 48_000;
const TEXT_TAIL = 16_000;

const UNQUOTED = String.raw`(?:\\.|[^\s"'\`<>|;&()\\])+`;
const ABSOLUTE = String.raw`(?:~|\.{1,2}|\$\{?[A-Za-z_]\w*\}?)?\/${UNQUOTED}`;
/** `C:\x`, `C:/x` and `\\server\share\x`, matched before shell escapes since backslashes are separators there. */
const WINDOWS = String.raw`[A-Za-z]:[\\/][^\s"'\`<>|;&()]*|\\\\[\w.$-]+\\[^\s"'\`<>|;&()]*`;
const RELATIVE = String.raw`[\w@+-][\w.@+-]*(?:\/[\w.@+-]+)+|[\w@+-][\w.@+-]*\.(?:pdf|png|jpe?g|gif|webp|avif|bmp|ico|svg)\b`;
const BEFORE = String.raw`(?<![\w.~$/@+\\-])`;
/** In arguments (commands, code): quoted strings, Windows paths, `/abs`, `~/x`, `./x`, `$VAR/x`, `a/b` and bare `name.pdf`. */
const ARGUMENT_TOKEN = new RegExp(String.raw`"([^"\n]{1,1024})"|'([^'\n]{1,1024})'|${BEFORE}(${WINDOWS}|${ABSOLUTE}|${RELATIVE})`, "g");
/** In printed output, where quotes are often apostrophes: rooted paths only. */
const OUTPUT_TOKEN = new RegExp(String.raw`${BEFORE}(${WINDOWS}|${ABSOLUTE})`, "g");
const WINDOWS_ROOTED = /^(?:[A-Za-z]:[\\/]|\\\\)/;
/** Shell assignments (`OUT="/x"`, `export OUT=/x`), so `$OUT/previews` resolves. */
const ASSIGNMENT = /(?:^|[\s;&|(])(?:export\s+|local\s+)?([A-Za-z_]\w*)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;&|)'"]+))/g;
const SYSTEM_PATH = /^\/(?:dev|proc|sys)(?:\/|$)/;

function clip(text: string): string {
	return text.length > TEXT_HEAD + TEXT_TAIL ? `${text.slice(0, TEXT_HEAD)}\n${text.slice(-TEXT_TAIL)}` : text;
}

/** Quoted text that names a path: rooted, or one word with a slash or a file extension (so quoted prose is not). */
function quotedLooksLikePath(text: string): boolean {
	if (WINDOWS_ROOTED.test(text) || /^(?:\/|~\/|\.{1,2}\/|\$)/.test(text)) return true;
	return !/\s/.test(text) && (text.includes("/") || /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(text));
}

/**
 * A token as a path, or null: known `$VARS` resolved, shell escapes removed (POSIX paths only; in Windows paths a
 * backslash is a separator, and doubled ones from printed string literals collapse), a trailing `:12:3` or
 * punctuation dropped, and cut before the first segment that still holds a variable or a glob (`$OUT/*.pdf` names
 * the folder `$OUT`).
 */
function cleanToken(raw: string, vars: ReadonlyMap<string, string>): string | null {
	const windows = WINDOWS_ROOTED.test(raw);
	const unescaped = windows ? raw.replace(/(?<!^)\\{2,}/g, "\\") : raw.replace(/\\(.)/g, "$1");
	const expanded = unescaped.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (match, name: string) => vars.get(name) ?? match);
	const trimmed = expanded.replace(/(?::\d+){1,2}$/, "").replace(windows ? /[.,:;)\]}'"/\\]+$/ : /[.,:;)\]}'"/]+$/, "");
	const open = trimmed.search(/[$`{}*?[\]]/);
	const separator = open === -1 ? -1 : windows ? Math.max(trimmed.lastIndexOf("/", open), trimmed.lastIndexOf("\\", open)) : trimmed.lastIndexOf("/", open);
	const path = open === -1 ? trimmed : separator > 0 ? trimmed.slice(0, separator) : "";
	if (windows && !WINDOWS_ROOTED.test(path)) return null;
	return path && path !== "~" && path !== "." && path !== ".." ? path : null;
}

function argumentStrings(value: unknown, out: string[], depth = 0): void {
	if (typeof value === "string") out.push(value);
	else if (depth < 3 && Array.isArray(value)) for (const item of value) argumentStrings(item, out, depth + 1);
	else if (depth < 3 && isRecord(value)) for (const key in value) argumentStrings(value[key], out, depth + 1);
}

/** Absolute paths a command call names in its arguments and its printed output, in order, without duplicates. */
export function commandPaths(args: Record<string, unknown>, output: string, context: OutputContext): string[] {
	const texts: string[] = [];
	argumentStrings(args, texts);
	const vars = new Map<string, string>();
	for (const text of texts) {
		for (const match of clip(text).matchAll(ASSIGNMENT)) vars.set(match[1], cleanToken(match[2] ?? match[3] ?? match[4] ?? "", vars) ?? "");
	}
	const cwd = str(args.cwd);
	const base = { ...context, cwd: (cwd && resolveOutputPath(cwd, context)) || context.cwd };
	const paths = new Set<string>();
	const take = (raw: string) => {
		const token = cleanToken(raw, vars);
		const path = token ? resolveOutputPath(token, base) : null;
		if (path && path !== "/" && !SYSTEM_PATH.test(path) && paths.size < PATHS_PER_CALL) paths.add(path);
	};
	const scanOutput = (text: string) => {
		for (const match of text.matchAll(OUTPUT_TOKEN)) take(match[1]);
	};
	for (const text of texts) {
		for (const match of clip(text).matchAll(ARGUMENT_TOKEN)) {
			const quoted = match[1] ?? match[2];
			if (quoted === undefined) take(match[3]);
			else if (quotedLooksLikePath(quoted)) take(quoted);
			// A quoted span that isn't a path may be prose between apostrophes; rooted paths inside it still count.
			else scanOutput(quoted);
		}
	}
	scanOutput(clip(output));
	return [...paths];
}

export interface MadeCandidate extends PaneMadeQuery {
	/** The tool call's id. */
	id: string;
}

/**
 * Finished `bash`, `eval` and `browser` calls that name paths, with the window they ran in: from the call's start
 * to its result, or for a background `bash` job to the delivery of its result. Main checks these paths for files
 * modified inside the window (`panes:scanMade`).
 */
export function madeCandidates(entries: readonly SessionEntry[], context: OutputContext): MadeCandidate[] {
	const candidates: MadeCandidate[] = [];
	const byJob = new Map<string, MadeCandidate>();
	for (const item of transcriptItems(entries)) {
		if (item.kind === "custom") {
			if (item.customType !== "async-result" || !isRecord(item.details) || !Number.isFinite(item.time)) continue;
			const jobs = Array.isArray(item.details.jobs) ? item.details.jobs : [item.details];
			for (const job of jobs) {
				const candidate = isRecord(job) ? byJob.get(str(job.jobId) ?? "") : undefined;
				if (candidate) candidate.end = Math.max(candidate.end, item.time);
			}
			continue;
		}
		if (item.kind !== "result" || !Object.hasOwn(COMMAND_TOOLS, item.name)) continue;
		const paths = commandPaths(item.args, resultText(item.message), context);
		if (paths.length === 0) continue;
		const candidate = { id: item.message.toolCallId, paths, start: item.start, end: item.message.timestamp };
		candidates.push(candidate);
		const jobId = item.name === "bash" && isRecord(item.details?.async) ? str(item.details.async.jobId) : null;
		if (jobId) byJob.set(jobId, candidate);
	}
	return candidates;
}

/** Files main found for each candidate (`panes:scanMade`), by tool call id. */
export type MadeFiles = Readonly<Record<string, readonly PaneMadeFile[]>>;

// ── all outputs ─────────────────────────────────────────────────────────────────────────────────

/**
 * Images, PDFs and files omp made or showed in a chat, newest first: image blocks in tool results (with the `read`
 * path when there is one), PDFs omp read, `generate_image` results paired with their saved paths, files written or
 * changed by `write`, `edit` and `ast_edit` (a staged `ast_edit` preview counts once `resolve` applies it), and the
 * files main found that a command made (`made`). A path appears once, at its newest use; images without a path are
 * separate items.
 */
export function chatOutputs(entries: readonly SessionEntry[], context: OutputContext, made: MadeFiles = {}): ChatOutput[] {
	const outputs = new Map<string, ChatOutput>();
	/** Paths the chat read successfully, which shows they existed then (text reads leave no output of their own). */
	const read = new Set<string>();
	const add = (output: Omit<ChatOutput, "produced" | "relation">) => {
		const previous = outputs.get(output.key);
		const produced = PRODUCES[output.action] || previous?.produced === true;
		// The first producing use decides; a file seen earlier in the chat existed, so producing it changes it.
		const relation: OutputRelation = previous?.produced
			? previous.relation
			: !PRODUCES[output.action]
				? "viewed"
				: previous || read.has(output.key)
					? "changed"
					: FIRST_PRODUCED[output.action];
		outputs.delete(output.key);
		outputs.set(output.key, { ...output, produced, relation });
	};
	const addFile = (raw: string, tool: string, action: OutputAction, time: number, base: OutputContext) => {
		const path = resolveOutputPath(raw, base);
		if (path) add({ key: path, kind: kindOf(path), path, tool, action, time, inline: null });
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
		if (name === "read") {
			const raw = readPath(details, args);
			const path = raw ? resolveOutputPath(raw, context) : null;
			if (path && !message.isError) read.add(path);
			if (path && PDF_EXT.test(path)) {
				// Rendered pages belong to the PDF, which the pane previews itself.
				images.length = 0;
				if (!message.isError) add({ key: path, kind: "pdf", path, tool: name, action: "viewed", time, inline: null });
			} else if (images.length === 1) paths = [path];
		}
		const imageAction: OutputAction = name === "read" ? "viewed" : name === "generate_image" ? "generated" : "captured";
		for (let n = 0; n < Math.max(images.length, paths.length); n++) {
			const inline = images[n] ?? null;
			const path = paths[n] ?? null;
			if (!inline && !path) continue;
			// A video frame shares its file's path, so only image files merge by path.
			const key = path && IMAGE_EXT.test(path) ? path : `${message.toolCallId}#${n}`;
			add({ key, kind: "image", path, tool: name, action: imageAction, time, inline });
		}
		// Main returns a call's files newest first; adding them oldest first keeps that order in the result.
		for (const file of [...(made[message.toolCallId] ?? [])].reverse()) addFile(file.path, name, "made", time, context);
		if (message.isError) continue;
		if (name === "write") {
			const raw = str(details?.resolvedPath) ?? str(args.path);
			if (raw) addFile(raw, "write", "written", time, context);
		} else if (name === "edit") {
			for (const file of editPaths(details, args)) addFile(file.path, "edit", file.created ? "created" : "edited", time, context);
		} else if (name === "ast_edit") {
			const base = { ...context, cwd: str(details?.cwd) ?? context.cwd };
			if (details?.applied === false) staged = { paths: astEditPaths(details), base };
			else for (const raw of astEditPaths(details)) addFile(raw, "ast_edit", "edited", time, base);
		} else if (name === "resolve" || name === "reject") {
			const action = str(details?.action) ?? str(args.action) ?? (name === "reject" ? "discard" : "apply");
			const source = str(details?.sourceToolName) ?? "ast_edit";
			if (staged && action === "apply" && source === "ast_edit") for (const raw of staged.paths) addFile(raw, "ast_edit", "edited", time, staged.base);
			staged = null;
		}
	}
	return [...outputs.values()].reverse();
}

// ── files omp changed ───────────────────────────────────────────────────────────────────────────

/** One file one tool call changed. Counts come from omp's own diff for that call; null when the result carries none. */
export interface FileEdit {
	/** Absolute when it could be resolved, else as the tool named it. */
	path: string;
	action: "edited" | "created" | "written";
	added: number | null;
	removed: number | null;
}

function diffLineCounts(diff: string | null): { added: number | null; removed: number | null } {
	if (diff === null) return { added: null, removed: null };
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/**
 * Files each successful `edit`, `write` and `ast_edit` call changed, by tool call id. Failed calls and failed files are
 * left out; a staged `ast_edit` preview counts only once `resolve` applies it, under the resolve call. `write` reports
 * no diff (it may have replaced a file), and `ast_edit` none that can be counted, so their line counts stay unknown.
 */
export function fileEdits(entries: readonly SessionEntry[], context: OutputContext): Map<string, FileEdit[]> {
	const edits = new Map<string, FileEdit[]>();
	const resolve = (raw: string, base: OutputContext) => resolveOutputPath(raw, base) ?? raw;
	let staged: { paths: string[]; base: OutputContext } | null = null;
	for (const item of transcriptItems(entries)) {
		if (item.kind !== "result" || item.message.isError) continue;
		const { name, args, details } = item;
		const id = item.message.toolCallId;
		const files: FileEdit[] = [];
		if (name === "write") {
			const raw = str(details?.resolvedPath) ?? str(args.path) ?? str(args.file_path);
			if (raw) files.push({ path: resolve(raw, context), action: "written", added: null, removed: null });
		} else if (name === "edit" || name === "apply_patch") {
			const perFile = Array.isArray(details?.perFileResults) ? details.perFileResults.filter(isRecord) : [];
			const sources = perFile.length > 0 ? perFile : details ? [{ ...details, path: str(details.path) ?? str(args.path) ?? str(args.file_path) }] : [];
			for (const file of sources) {
				const raw = file.isError === true ? null : str(file.path);
				if (raw) files.push({ path: resolve(raw, context), action: file.op === "create" ? "created" : "edited", ...diffLineCounts(str(file.diff)) });
			}
		} else if (name === "ast_edit") {
			const base = { ...context, cwd: str(details?.cwd) ?? context.cwd };
			if (details?.applied === false) staged = { paths: astEditPaths(details), base };
			else for (const raw of astEditPaths(details)) files.push({ path: resolve(raw, base), action: "edited", added: null, removed: null });
		} else if (name === "resolve" || name === "reject") {
			const action = str(details?.action) ?? str(args.action) ?? (name === "reject" ? "discard" : "apply");
			const source = str(details?.sourceToolName) ?? "ast_edit";
			if (staged && action === "apply" && source === "ast_edit") {
				for (const raw of staged.paths) files.push({ path: resolve(raw, staged.base), action: "edited", added: null, removed: null });
			}
			staged = null;
		}
		if (files.length > 0) edits.set(id, files);
	}
	return edits;
}

/** A file's edit totals over several calls. Counts are null when any of its calls reported none. */
export interface FileEditTotal {
	path: string;
	/** `created` or `written` when the first change made or wrote the file, else `edited`. */
	action: FileEdit["action"];
	added: number | null;
	removed: number | null;
}

export interface EditTotals {
	files: FileEditTotal[];
	/** Sums over the files whose counts are known. Repeated edits to one file all count: this is not a net diff. */
	added: number;
	removed: number;
	/** Some file's counts are unknown, so the sums leave it out. */
	partial: boolean;
}

/** Edit totals for a set of calls, one row per file in first-change order. */
export function editTotals(edits: ReadonlyMap<string, readonly FileEdit[]>, callIds: Iterable<string>): EditTotals {
	const files = new Map<string, FileEditTotal>();
	const seen = new Set<string>();
	for (const id of callIds) {
		if (seen.has(id)) continue;
		seen.add(id);
		for (const edit of edits.get(id) ?? []) {
			const total = files.get(edit.path);
			if (!total) {
				files.set(edit.path, { ...edit });
				continue;
			}
			total.added = total.added === null || edit.added === null ? null : total.added + edit.added;
			total.removed = total.removed === null || edit.removed === null ? null : total.removed + edit.removed;
		}
	}
	let added = 0;
	let removed = 0;
	let partial = false;
	for (const file of files.values()) {
		if (file.added === null || file.removed === null) partial = true;
		else {
			added += file.added;
			removed += file.removed;
		}
	}
	return { files: [...files.values()], added, removed, partial };
}

// ── plan checklist ──────────────────────────────────────────────────────────────────────────────

export interface PlanStep {
	text: string;
	checked: boolean;
	/** Nesting level from the list indent, 0 for top-level steps. */
	depth: number;
}

const CHECKBOX = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+)$/;

/** Markdown checkbox steps (`- [ ] step`, `1. [x] step`) in a plan, outside code fences; null when it has none. */
export function planChecklist(text: string): PlanStep[] | null {
	const steps: PlanStep[] = [];
	let fence: string | null = null;
	for (const line of text.split("\n")) {
		const marker = /^\s*(```+|~~~+)/.exec(line)?.[1];
		if (marker) {
			if (fence === null) fence = marker[0];
			else if (marker[0] === fence) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const match = CHECKBOX.exec(line);
		if (!match) continue;
		const indent = match[1].replace(/\t/g, "  ").length;
		steps.push({ text: match[3].trim(), checked: match[2] !== " ", depth: Math.min(3, Math.floor(indent / 2)) });
	}
	return steps.length > 0 ? steps : null;
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A helper's outcome as the app shows it. omp keeps a helper that finished its turn (`idle`, later `parked` with its
 * session saved) so it can take a follow-up message; that helper is done, and `Helper.messageable` records that omp
 * still holds it.
 */
export type HelperStatus = "running" | "done" | "failed" | "stopped";

/** A subagent as the Tasks pane and the chat header show it. Numbers are null when omp has not reported them. */
export interface Helper {
	id: string;
	name: string;
	status: HelperStatus;
	/** What it is doing now, or what it was asked to do. */
	activity: string;
	tokens: number | null;
	toolCount: number | null;
	/** Run time omp last reported for it. */
	durationMs: number | null;
	/**
	 * `Date.now()` when the app received `durationMs` from omp's live progress, so a working helper's time can run on
	 * between reports; null when it came from the transcript, which records a run time that no longer advances.
	 */
	durationAt: number | null;
	contextTokens: number | null;
	contextWindow: number | null;
	model: string | null;
	hasTranscript: boolean;
	/**
	 * omp holds the helper and takes a message now: it runs, or it finished and omp keeps it (`idle` or `parked`) for a
	 * follow-up, which runs it again. Always false without a running omp, and for helpers read from a task call.
	 */
	messageable: boolean;
}

const SNAPSHOT_STATUS: Record<AgentSnapshot["status"], HelperStatus> = { running: "running", idle: "done", parked: "done", aborted: "stopped" };
const PROGRESS_STATUS: Record<AgentProgress["status"], HelperStatus> = { pending: "running", running: "running", completed: "done", failed: "failed", aborted: "stopped" };
const LIFECYCLE_STATUS: Record<SubagentLifecyclePayload["status"], HelperStatus> = { started: "running", completed: "done", failed: "failed", aborted: "stopped" };
/** A task job's state in a `job`/`wait` snapshot or a delivery, as the helper's status. */
const JOB_HELPER_STATUS: Record<JobState, HelperStatus> = { running: "running", completed: "done", failed: "failed", cancelled: "stopped" };

/** A task progress record's status; anything else reads as running, like omp's pending. */
export function progressStatus(value: unknown): HelperStatus {
	return value === "completed" || value === "failed" || value === "aborted" ? PROGRESS_STATUS[value] : "running";
}

/** How a task call's final result record ended, mirroring the TUI's aborted / done / failed split. */
export function taskResultStatus(result: Record<string, unknown>): HelperStatus {
	if (result.aborted === true) return "stopped";
	return num(result.exitCode) === 0 && !str(result.error) ? "done" : "failed";
}

/**
 * Whether an omp process may still run this chat's helpers and jobs: this tab's own (starting, live or reconnecting),
 * or another process that has the saved file open (the read-only follow, unless the follow found the file free: the
 * tab stays read-only until Continue here, but no other process writes it). A saved chat nobody runs, or one whose
 * omp exited, runs nothing.
 */
export function ompRunning(view: Pick<SessionView, "mode" | "readOnly" | "follow"> | null | undefined): boolean {
	if (!view) return false;
	if (view.readOnly) return view.follow?.ownership !== "free";
	return view.mode === "starting" || view.mode === "live" || view.mode === "reconnecting";
}

/**
 * Each helper's last state the transcript records, by helper id: what its `task` call's result said (final results,
 * else the progress a background spawn returns with), then the task jobs in `job`/`wait` results and `async-result`
 * deliveries, later reports winning. A delivery for a helper messaged again names the run `<id>-2`; its label is the
 * helper id, so both keys are set. A helper still working at a `session_exit` record stopped with omp.
 */
export function transcriptHelperStates(entries: readonly SessionEntry[]): ReadonlyMap<string, HelperStatus> {
	const states = new Map<string, HelperStatus>();
	for (const item of transcriptItems(entries)) {
		if (item.kind === "exit") {
			for (const [id, status] of states) if (status === "running") states.set(id, "stopped");
			continue;
		}
		if (item.kind === "result" && item.name === "task") {
			const results = Array.isArray(item.details?.results) ? item.details.results.filter(isRecord) : [];
			const progress = Array.isArray(item.details?.progress) ? item.details.progress.filter(isRecord) : [];
			for (const record of results.length > 0 ? results : progress) {
				const id = str(record.id);
				if (id) states.set(id, results.length > 0 ? taskResultStatus(record) : progressStatus(record.status));
			}
			continue;
		}
		for (const report of jobReports(item)) {
			if (report.type !== "task") continue;
			states.set(report.id, JOB_HELPER_STATUS[report.state]);
			if (report.label) states.set(report.label, JOB_HELPER_STATUS[report.state]);
		}
	}
	return states;
}

/**
 * A helper's status once the transcript and omp's absence apply. `recorded` (from `transcriptHelperStates`) replaces
 * the status of a helper read from its task call's own result, which a background spawn writes once, at the start;
 * pass null for live helpers, whose status omp keeps current. Without a running omp, a helper still marked working has
 * stopped, and none takes a message: a done helper omp kept for a follow-up stays done.
 */
export function settleHelper(helper: Helper, recorded: ReadonlyMap<string, HelperStatus> | null, ompLive: boolean): Helper {
	const status = recorded?.get(helper.id) ?? helper.status;
	const settled = !ompLive && status === "running" ? "stopped" : status;
	const messageable = ompLive && helper.messageable;
	return settled === helper.status && messageable === helper.messageable ? helper : { ...helper, status: settled, messageable };
}

/**
 * omp sends a helper its assignment wrapped in `prompts/system/subagent-user-prompt.md` ("Complete assignment
 * thoroughly:" then the parent's text) and reports that wrapped text as `progress.task`. omp's own agent views strip
 * it with this same pattern.
 */
const ASSIGNMENT_PREAMBLE = /^\s*Complete assignment thoroughly:\s*/i;

/** The parent's assignment without omp's preamble. */
export function stripAssignmentPreamble(text: string): string {
	return text.replace(ASSIGNMENT_PREAMBLE, "");
}

/** The first line of `text` that says something: blank lines and Markdown heading lines ("# Target") are skipped. */
function firstLine(text: string | null | undefined): string {
	if (!text) return "";
	let heading = "";
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const title = /^#{1,6}\s+(.*)$/.exec(line);
		if (!title) return line;
		heading ||= title[1]?.trim() ?? "";
	}
	return heading;
}

/** The fields a helper's activity line is chosen from: live progress, or a task result record, which lacks some. */
export interface ActivitySource {
	currentToolIntent?: string | null;
	lastIntent?: string | null;
	recentTools?: readonly { intent?: string | null }[];
	recentOutput?: readonly string[];
	description?: string | null;
	task?: string | null;
}

/**
 * What a helper is doing, latest first: the intent of its current call, its last intent, the intent of its latest
 * finished call, its latest line of output; before it has done anything, the label omp generated for the task, then
 * the first line of its assignment (without omp's preamble).
 */
export function activityOf(progress: ActivitySource | undefined): string {
	if (!progress) return "";
	return (
		firstLine(progress.currentToolIntent) ||
		firstLine(progress.lastIntent) ||
		firstLine(progress.recentTools?.find(tool => tool.intent)?.intent) ||
		firstLine(progress.recentOutput?.[0]) ||
		firstLine(progress.description) ||
		firstLine(progress.task && stripAssignmentPreamble(progress.task))
	);
}

function progressFields(
	live: AgentProgress | undefined,
	receivedAt: number | null,
): Pick<Helper, "tokens" | "toolCount" | "durationMs" | "durationAt" | "contextTokens" | "contextWindow" | "model"> {
	const positive = (value: number | undefined) => (value !== undefined && Number.isFinite(value) && value > 0 ? value : null);
	const durationMs = positive(live?.durationMs);
	return {
		tokens: live ? live.tokens : null,
		toolCount: live ? live.toolCount : null,
		durationMs,
		durationAt: durationMs !== null ? receivedAt : null,
		contextTokens: positive(live?.contextTokens),
		contextWindow: positive(live?.contextWindow),
		model: live?.resolvedModel ?? null,
	};
}

type HelperSources = Pick<GuestSnapshot, "agents" | "progress" | "lifecycle">;

/**
 * Each helper's status by id before omp's absence applies (`settleHelper`), in the order `helpersOf` first meets
 * them: the subagents in omp's `agents` list, helpers known only from task progress, then ones known only from their
 * lifecycle. A finished task reports completed or failed in progress while the registry says idle; a lifecycle event
 * is the latest word, so a parked helper a message wakes reads as running again.
 */
function helperStatuses(guest: HelperSources): Map<string, HelperStatus> {
	const statuses = new Map<string, HelperStatus>();
	const reported = new Map<string, AgentProgress>();
	for (const payload of guest.progress.values()) reported.set(payload.progress.id, payload.progress);
	for (const agent of guest.agents) {
		if (agent.kind !== "sub") continue;
		const live = reported.get(agent.id);
		statuses.set(agent.id, live && live.status !== "running" && live.status !== "pending" ? PROGRESS_STATUS[live.status] : SNAPSHOT_STATUS[agent.status]);
	}
	for (const [id, live] of reported) if (!statuses.has(id)) statuses.set(id, PROGRESS_STATUS[live.status]);
	for (const [id, event] of guest.lifecycle) statuses.set(id, LIFECYCLE_STATUS[event.status]);
	return statuses;
}

/**
 * Subagents from the collab `agents` list merged with their task progress and lifecycle: running ones first, in omp's
 * order, then the finished ones newest first (by the app's latest progress report from each, else omp's last activity
 * for it, later-listed helpers first on a tie). A helper omp keeps after its turn (`idle` or `parked`) is done and
 * `messageable`; when a message runs it again, omp reports it started and it reads as running. Without a running omp
 * (`ompLive` false, from `ompRunning`: a stale mirror), none still works or takes a message (`settleHelper`).
 */
export function helpersOf(guest: HelperSources | null | undefined, ompLive: boolean): Helper[] {
	if (!guest) return [];
	const statuses = helperStatuses(guest);
	// Every id listed below has a status: `helperStatuses` walks the same three sources.
	const statusOf = (id: string): HelperStatus => statuses.get(id) ?? "stopped";
	const progress = new Map<string, { live: AgentProgress; receivedAt: number }>();
	for (const payload of guest.progress.values()) progress.set(payload.progress.id, { live: payload.progress, receivedAt: payload.receivedAt });
	const helpers = new Map<string, Helper>();
	const heardAt = new Map<string, number>();
	for (const agent of guest.agents) {
		if (agent.kind !== "sub") continue;
		const { live, receivedAt } = progress.get(agent.id) ?? { live: undefined, receivedAt: null };
		helpers.set(agent.id, {
			id: agent.id,
			name: agent.displayName || live?.agent || agent.id,
			status: statusOf(agent.id),
			activity: activityOf(live),
			...progressFields(live, receivedAt),
			hasTranscript: agent.hasSessionFile,
			messageable: agent.status !== "aborted",
		});
		heardAt.set(agent.id, receivedAt ?? agent.lastActivity);
	}
	for (const [id, { live, receivedAt }] of progress) {
		if (helpers.has(id)) continue;
		helpers.set(id, {
			id,
			name: live.agent || id,
			status: statusOf(id),
			activity: activityOf(live),
			...progressFields(live, receivedAt),
			hasTranscript: false,
			messageable: false,
		});
		heardAt.set(id, receivedAt);
	}
	for (const [id, event] of guest.lifecycle) {
		const existing = helpers.get(id);
		if (existing) {
			if (!existing.activity && event.description) existing.activity = event.description;
			continue;
		}
		helpers.set(id, {
			id,
			name: event.agent || id,
			status: statusOf(id),
			activity: event.description ?? "",
			...progressFields(undefined, null),
			hasTranscript: Boolean(event.sessionFile),
			messageable: false,
		});
	}
	const listed = [...helpers.values()].map((helper, index) => {
		// A running helper takes a message whichever source reported it.
		if (helper.status === "running") helper.messageable = true;
		return { helper: settleHelper(helper, null, ompLive), index, heardAt: heardAt.get(helper.id) ?? 0 };
	});
	const running = listed.filter(item => item.helper.status === "running");
	const finished = listed.filter(item => item.helper.status !== "running").sort((a, b) => b.heardAt - a.heardAt || b.index - a.index);
	return [...running, ...finished].map(item => item.helper);
}

interface RunningCount {
	progress: HelperSources["progress"];
	lifecycle: HelperSources["lifecycle"];
	count: number;
}

/**
 * The last count per chat, keyed by the chat's `agents` list and checked against its progress and lifecycle maps. The
 * collab client replaces each of the three when a helper update arrives and keeps them otherwise, so streamed text
 * reuses the count.
 */
const runningCounts = new WeakMap<HelperSources["agents"], RunningCount>();

/**
 * How many of the chat's helpers are working now: the running helpers `helpersOf` lists, the rule the Tasks badge and
 * the pinned helper strip use. A helper that finished (omp keeps it idle or parked for a follow-up) is not working, and
 * a mirror without a running omp (`ompRunning`) has none at work.
 */
export function runningHelpers(view: Pick<SessionView, "guest" | "mode" | "readOnly" | "follow"> | null): number {
	const guest = view?.guest;
	if (!guest || !ompRunning(view)) return 0;
	const cached = runningCounts.get(guest.agents);
	if (cached && cached.progress === guest.progress && cached.lifecycle === guest.lifecycle) return cached.count;
	let count = 0;
	for (const status of helperStatuses(guest).values()) if (status === "running") count++;
	runningCounts.set(guest.agents, { progress: guest.progress, lifecycle: guest.lifecycle, count });
	return count;
}

/** Whether any of the chat's helpers is working now (`runningHelpers`). */
export function helpersAtWork(view: Pick<SessionView, "guest" | "mode" | "readOnly" | "follow"> | null): boolean {
	return runningHelpers(view) > 0;
}

/**
 * Finished helpers the Tasks pane lists before "Show earlier helpers". A finished card with omp's numbers is about
 * 127px tall in a 312px pane, so three show what just finished in about 400px and leave the running helpers and the
 * background jobs within reach. It matches the three running helpers the chat pins (`PINNED_ROWS`).
 */
export const RECENT_HELPERS = 3;

export interface HelperFold {
	/** The helpers to list, in `helpersOf` order. */
	shown: readonly Helper[];
	/** How many helpers the fold hides; the count stays the same while the list is expanded. */
	earlier: number;
}

/**
 * The Tasks pane's helper list from `helpersOf`: every running helper, the `RECENT_HELPERS` latest finished ones, and
 * any older failed one, which stays in view because a failure is the outcome the reader most likely has to act on.
 * `expanded` lists every helper.
 */
export function foldHelpers(helpers: readonly Helper[], expanded: boolean): HelperFold {
	const kept: Helper[] = [];
	let finished = 0;
	for (const helper of helpers) {
		if (helper.status === "running" || finished++ < RECENT_HELPERS || helper.status === "failed") kept.push(helper);
	}
	return { shown: expanded ? helpers : kept, earlier: helpers.length - kept.length };
}

/**
 * The helpers each `task` call started, by tool call id, in the order the call listed them. omp tags progress and
 * lifecycle events with the spawning call (`parentToolCallId`); helpers without that tag are left out. This is the
 * live state: a task call that spawns in the background returns at once while its helpers keep working.
 */
export function helpersByCall(
	guest: Pick<GuestSnapshot, "agents" | "progress" | "lifecycle"> | null | undefined,
	ompLive: boolean,
): ReadonlyMap<string, readonly Helper[]> {
	if (!guest) return new Map();
	const parents = new Map<string, { call: string; index: number }>();
	for (const payload of guest.progress.values()) {
		if (payload.parentToolCallId) parents.set(payload.progress.id, { call: payload.parentToolCallId, index: payload.index });
	}
	for (const event of guest.lifecycle.values()) {
		if (event.parentToolCallId && !parents.has(event.id)) parents.set(event.id, { call: event.parentToolCallId, index: event.index });
	}
	if (parents.size === 0) return new Map();
	const byCall = new Map<string, { helper: Helper; index: number }[]>();
	for (const helper of helpersOf(guest, ompLive)) {
		const parent = parents.get(helper.id);
		if (!parent) continue;
		byCall.set(parent.call, [...(byCall.get(parent.call) ?? []), { helper, index: parent.index }]);
	}
	const result = new Map<string, readonly Helper[]>();
	for (const [call, list] of byCall) result.set(call, list.sort((a, b) => a.index - b.index).map(item => item.helper));
	return result;
}

// ── work summary ────────────────────────────────────────────────────────────────────────────────

export interface WorkSummary {
	/** Null when omp made no checklist. */
	tasks: TodoCounts | null;
	helpersWorking: number;
	jobsRunning: number;
}

/** The counts the chat header's work chip shows. */
export function workSummary(phases: readonly TodoPhase[] | null, helpers: readonly Helper[], jobs: readonly BackgroundJob[]): WorkSummary {
	const tasks = phases ? todoCounts(phases) : null;
	return {
		tasks: tasks && tasks.total + tasks.abandoned > 0 ? tasks : null,
		helpersWorking: helpers.filter(helper => helper.status === "running").length,
		jobsRunning: jobs.filter(job => job.state === "running").length,
	};
}
