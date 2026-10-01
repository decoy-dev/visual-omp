/**
 * Pure read-outs of a chat's transcript for the dock: the latest todo checklist, background shell
 * jobs, dev-server URLs printed by commands, and the images and files omp made. Tolerant of
 * partial/unknown shapes, since everything here comes from omp's JSON over the wire.
 */
import type { SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { PaneMadeFile, PaneMadeQuery } from "@shared/contracts/panes";
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
	| {
			kind: "result";
			name: string;
			args: Record<string, unknown>;
			details: Record<string, unknown> | null;
			message: ToolResultMessage;
			/** Epoch ms the call started, never after the result; the result time when unknown. */
			start: number;
	  }
	| { kind: "custom"; customType: string; details: unknown; time: number };

function resultText(message: ToolResultMessage): string {
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/** When a call started: omp's `tool_execution_start` entry (saved sessions only) or the assistant message that made it. */
function startTime(recorded: number | undefined, called: number | undefined, end: number): number {
	for (const time of [recorded, called]) if (time !== undefined && Number.isFinite(time) && time > 0 && time <= end) return time;
	return end;
}

/**
 * Tool results paired with their calls (normalized like the transcript: `write` → `xd://<tool>`
 * device calls become the device tool, with the device's own details) and custom messages, in order.
 */
function transcriptItems(entries: readonly SessionEntry[]): TranscriptItem[] {
	const calls = new Map<string, { name: string; args: unknown; time: number }>();
	const starts = new Map<string, number>();
	const items: TranscriptItem[] = [];
	for (const entry of entries) {
		// Saved sessions also hold omp's `custom` bookkeeping entries, which the wire types leave out.
		const type: string = entry.type;
		if (type === "custom") {
			const { customType, data } = entry as unknown as { customType?: unknown; data?: unknown };
			const id = customType === "tool_execution_start" && isRecord(data) ? str(data.toolCallId) : null;
			if (id && isRecord(data)) starts.set(id, Date.parse(str(data.startedAt) ?? entry.timestamp));
			continue;
		}
		if (entry.type === "custom_message") {
			items.push({ kind: "custom", customType: entry.customType, details: entry.details, time: Date.parse(entry.timestamp) });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") calls.set(block.id, { name: block.name, args: block.arguments, time: message.timestamp });
			}
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
		const start = startTime(starts.get(message.toolCallId), call?.time, message.timestamp);
		items.push({ kind: "result", name: view.name, args: view.args, details: isRecord(details) ? details : null, message, start });
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
export const PDF_EXT = /\.pdf$/i;
/** Files main opens in the default app and thumbnails (`panes:openOutput` also checks the bytes); SVG stays in-app. */
export const OPENABLE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf)$/i;

/** Image data in a tool result: base64 (the live stream may have cut it short) or a saved session's blob id. */
export type InlineImage = { kind: "data"; mimeType: string; data: string } | { kind: "blob"; hash: string };

/** How omp produced an output, for its "Edited 14:32" label. */
export type OutputAction = "viewed" | "written" | "edited" | "generated" | "captured" | "made";

/** Actions that create or change the file; `viewed` and `captured` only look at it. */
const PRODUCES: Record<OutputAction, boolean> = { viewed: false, captured: false, written: true, edited: true, generated: true, made: true };

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
		if (!Object.hasOwn(COMMAND_TOOLS, item.name)) continue;
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
	const add = (output: Omit<ChatOutput, "produced">) => {
		const produced = PRODUCES[output.action] || outputs.get(output.key)?.produced === true;
		outputs.delete(output.key);
		outputs.set(output.key, { ...output, produced });
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
			for (const raw of editPaths(details, args)) addFile(raw, "edit", "edited", time, context);
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
