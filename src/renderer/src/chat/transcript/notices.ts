/**
 * omp's harness notices (`custom_message` entries with `display: true`) as typed data, so the transcript and the
 * session tree show what happened instead of the model-facing wrapper text. Mirrors omp's own TUI
 * (`ChatTranscriptBuilder#appendCustomMessage`, `transcript-render-helpers.ts`): structured `details` first, and only
 * when they are missing does the parser read omp's wrapper markup (prompts/tools/async-result.md, task-summary.md,
 * system/irc-incoming.md, advisor `<advisory>` blocks, skills/user-invocation.md).
 */
import { z } from "zod";
import type { HostNotice } from "@shared/ipc";

export type JobStatus = "ok" | "failed" | "stopped";

export interface JobNotice {
	id: string;
	/** omp's job kind: a background command or a helper agent; null when the entry does not say. */
	type: "bash" | "task" | null;
	/** The command (bash) or helper name (task) omp recorded. */
	label: string | null;
	/** Run time from omp's details; null when unknown, or when the `<task-result>` tag gives the helper's own run time. */
	durationMs: number | null;
	/** omp's own duration text from the `<task-result>` tag, preferred for helpers. */
	durationText: string | null;
	status: JobStatus;
	/** The job's output with omp's wrapper removed; null when the content holds nothing for this job. */
	result: string | null;
	/** omp sent a preview: the helper's full output is in its transcript. */
	truncated: boolean;
}

export type IrcMode = "incoming" | "autoreply" | "relay";
export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdvisorNote {
	note: string;
	severity: AdvisorSeverity | null;
	advisor: string | null;
}

export interface ProcessExit {
	name: string;
	exitCode: number | null;
	failed: boolean;
	/** omp's sentence for this exit, used when `details` carry no process. */
	text: string;
}

export type Notice =
	| { kind: "jobs"; jobs: JobNotice[] }
	| { kind: "irc"; mode: IrcMode; from: string | null; to: string | null; body: string }
	| { kind: "launch"; processes: ProcessExit[] }
	| { kind: "advisor"; notes: AdvisorNote[] }
	| { kind: "skill"; name: string; args: string | null; path: string | null; text: string }
	| { kind: "other"; text: string };

export interface NoticeSource {
	customType: string;
	/** omp's content: a string, or text and image blocks (`TextContent | ImageContent` or a parsed session line). */
	content: string | readonly { type: string; text?: string }[];
	details?: unknown;
}

/** A non-empty string field, else undefined. */
const Field = z.string().trim().min(1).optional().catch(undefined);
const JobDetails = z.object({
	jobId: Field,
	type: z.enum(["bash", "task"]).optional().catch(undefined),
	label: Field,
	durationMs: z.number().nonnegative().optional().catch(undefined),
});
/** `async-result` details: a batch under `jobs`, or one job at the top level. */
const AsyncDetails = JobDetails.extend({ jobs: z.array(JobDetails).optional().catch(undefined) });
const IrcDetails = z.object({ from: Field, to: Field, message: Field, body: Field });
const LaunchDetails = z.object({
	daemons: z.array(z.object({ name: Field, state: z.string().optional().catch(undefined), exitCode: z.number().int().optional().catch(undefined) })).min(1),
});
const Severity = z.enum(["nit", "concern", "blocker"]);
const AdvisorDetails = z.object({
	notes: z.array(z.object({ note: z.string().trim().min(1), severity: Severity.optional().catch(undefined), advisor: Field })).min(1),
});
const SkillDetails = z.object({ name: Field, path: Field, args: Field });

function unescapeXml(text: string): string {
	return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[name] ?? "");
}

function attr(tag: string, name: string): string | null {
	const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
	return match?.[1] !== undefined ? unescapeXml(match[1]) : null;
}

/**
 * The text of a message's content: its text blocks, one per line. Image blocks add nothing; joining them as empty
 * strings left a trailing newline per image, which a `whitespace-pre-wrap` bubble drew as blank lines.
 */
export function contentText(content: NoticeSource["content"]): string {
	return typeof content === "string" ? content : content.flatMap(block => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

// ─── async-result ──────────────────────────────────────────────────────────

const SINGLE_HEADER = /^Background job (\S+) has completed\. Resume your work using the result below\.[^\S\n]*\n?/;
const BATCH_HEADER = /^\d+ background jobs have completed\. Resume your work using the results below\.\s*/;
/** omp's follow-up hint after a helper's result (`X is now idle — message it via …; transcript at history://X`). */
const IDLE_HINT = /^\S+ is now idle \S+ message it via [^\n]*$/gm;
const EXIT_LINE = /(?:^|\n)Command exited with code (-?\d+)\s*$/;

interface TaskResult {
	status: JobStatus;
	durationText: string | null;
	result: string;
	truncated: boolean;
}

function statusOf(raw: string | null): JobStatus {
	if (raw === null || raw.startsWith("completed")) return "ok";
	if (raw.startsWith("cancelled") || raw.startsWith("aborted")) return "stopped";
	return "failed";
}

/** The body of a `<task-result>` envelope (prompts/tools/task-summary.md). */
function parseTaskResult(text: string): TaskResult | null {
	const open = /<task-result\b[^>]*>/.exec(text);
	if (!open) return null;
	const close = text.indexOf("</task-result>", open.index);
	const inner = text.slice(open.index + open[0].length, close === -1 ? undefined : close);
	const body = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(inner);
	const abort = /<abort-reason>([\s\S]*?)<\/abort-reason>/.exec(inner)?.[1]?.trim();
	const result = body?.[2] ?? "";
	return {
		status: statusOf(attr(open[0], "status")),
		durationText: attr(open[0], "duration"),
		result: (result.trim() === "" && abort ? abort : result).trim(),
		truncated: body?.[1] === "preview",
	};
}

interface JobMeta {
	id: string | null;
	type: "bash" | "task" | null;
	label: string | null;
	durationMs: number | null;
}

const NO_META: JobMeta = { id: null, type: null, label: null, durationMs: null };

function jobMetas(details: unknown): JobMeta[] {
	const parsed = AsyncDetails.safeParse(details);
	if (!parsed.success) return [];
	const list = parsed.data.jobs?.length ? parsed.data.jobs : [parsed.data];
	return list.flatMap(job =>
		job.jobId === undefined && job.type === undefined && job.label === undefined && job.durationMs === undefined
			? []
			: [{ id: job.jobId ?? null, type: job.type ?? null, label: job.label ?? null, durationMs: job.durationMs ?? null }],
	);
}

/** One job's output in the content: the id its header names (null when the content names none) and the text under it. */
interface Segment {
	id: string | null;
	body: string;
}

/**
 * The content cut into one segment per job, read from omp's headers alone (prompts/tools/async-result.md): the single
 * "Background job X has completed" header, or `── Job <id> (<label>) ──` per job in a batch, where a label is the
 * command and may span lines. Text before the first batch header, if any, stays as a segment of its own.
 */
function segments(text: string): Segment[] {
	const inner = /^\s*<system-notice>\n?([\s\S]*?)\n?<\/system-notice>\s*$/.exec(text)?.[1] ?? text;
	const single = SINGLE_HEADER.exec(inner);
	if (single) return [{ id: single[1] ?? null, body: inner.slice(single[0].length) }];
	const batch = BATCH_HEADER.exec(inner);
	const body = inner.slice(batch?.[0].length ?? 0);
	if (!batch) return [{ id: null, body }];
	const headers: { id: string; start: number; end: number }[] = [];
	for (const match of body.matchAll(/(?:^|\n)── Job (\S+)(?= |\n)/g)) {
		const id = match[1] ?? "";
		const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
		if (start < (headers.at(-1)?.end ?? 0)) continue;
		const close = body.indexOf(" ──\n", start + match[0].length - 1);
		const end = close !== -1 ? close + 4 : body.endsWith(" ──") ? body.length : -1;
		if (end !== -1) headers.push({ id, start, end });
	}
	if (headers.length === 0) return [{ id: null, body }];
	const lead = body.slice(0, headers[0]!.start);
	const jobs = headers.map((header, index) => ({ id: header.id, body: body.slice(header.end, headers[index + 1]?.start) }));
	return lead.trim() ? [{ id: null, body: lead }, ...jobs] : jobs;
}

const DURATION_UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

/**
 * Milliseconds from omp's `formatDuration` text (pi-utils: "850ms", "21.1s", "2m41s", "1h3m", "2d4h"), so helper
 * durations print through the app's one formatter like every other duration in the chat. Null for anything else.
 */
export function parseOmpDuration(text: string): number | null {
	if (!/^(?:\d+(?:\.\d+)?(?:ms|[dhms]))+$/.test(text)) return null;
	let ms = 0;
	for (const [, value, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|[dhms])/g)) ms += Number(value) * (DURATION_UNITS[unit ?? ""] ?? 0);
	return Number.isFinite(ms) ? Math.round(ms) : null;
}

/** One row: what the content says about the job, completed by omp's structured details. */
function jobFrom(meta: JobMeta, segment: Segment | null): JobNotice {
	const id = meta.id ?? segment?.id ?? "";
	if (segment === null) {
		return { id, type: meta.type, label: meta.label, durationMs: meta.durationMs, durationText: null, status: "ok", result: null, truncated: false };
	}
	const task = parseTaskResult(segment.body);
	if (task) {
		// The envelope's duration is the helper's run time; details.durationMs measures the delivery (a helper woken
		// for a second round reports a few milliseconds there), so it only stands in when the envelope has none.
		const runMs = task.durationText === null ? null : parseOmpDuration(task.durationText);
		return {
			id,
			type: meta.type ?? "task",
			label: meta.label,
			durationMs: task.durationText === null ? meta.durationMs : runMs,
			durationText: runMs === null ? task.durationText : null,
			status: task.status,
			result: task.result,
			truncated: task.truncated,
		};
	}
	const result = segment.body.replace(IDLE_HINT, "").trim();
	const exit = EXIT_LINE.exec(result);
	return {
		id,
		type: meta.type,
		label: meta.label,
		durationMs: meta.durationMs,
		durationText: null,
		status: exit && exit[1] !== "0" ? "failed" : "ok",
		result,
		truncated: false,
	};
}

/**
 * Jobs in content order. Each segment takes the details entry with its job id; details without an id pair with the
 * segments left over, in order. Output nobody describes keeps its own row, and a described job missing from the
 * content gets a row with no result.
 */
function parseJobs(details: unknown, text: string): JobNotice[] {
	const metas = jobMetas(details);
	const found = segments(text);
	const used = new Set<JobMeta>();
	const matched = found.map(segment => {
		const meta = segment.id === null ? undefined : metas.find(item => !used.has(item) && item.id === segment.id);
		if (meta) used.add(meta);
		return meta;
	});
	const anonymous = metas.filter(meta => meta.id === null);
	const jobs = found.map((segment, index) => {
		let meta = matched[index];
		if (!meta) {
			meta = anonymous.find(item => !used.has(item));
			if (meta) used.add(meta);
		}
		return jobFrom(meta ?? NO_META, segment);
	});
	for (const meta of metas) if (!used.has(meta)) jobs.push(jobFrom(meta, null));
	return jobs;
}

// ─── irc ───────────────────────────────────────────────────────────────────

const IRC_HEADER = /^Incoming IRC message from agent `([^`]+)`(?: \(reply to [^)]*\))?:[^\S\n]*\n?/;
/** omp's instructions to the model after an IRC message (system/irc-incoming.md and its earlier wording). */
const IRC_FOOTERS = [
	/^Sent while waiting\/working\.[^\n]*$/gm,
	/^If response expected, reply via [^\n]*$/gm,
	/^Mid-task: context-generated side-channel auto-reply [^\n]*$/gm,
];

export interface IrcText {
	from: string | null;
	body: string;
}

/**
 * The sender and message of omp's IRC wrapper: the `<irc>` delivery block (system/irc-incoming.md) or the
 * `<irc from="…" agent="…">` block omp puts in a helper's prompt when a message interrupts its wait. Null when the
 * text holds no IRC block.
 */
export function parseIrcText(text: string): IrcText | null {
	const match = /<irc\b([^>]*)>\n?([\s\S]*?)\n?<\/irc>/.exec(text);
	if (!match) return null;
	let body = match[2] ?? "";
	let from = attr(match[1] ?? "", "agent") ?? attr(match[1] ?? "", "from");
	const header = IRC_HEADER.exec(body);
	if (header) {
		from = header[1] ?? from;
		body = body.slice(header[0].length);
	}
	for (const footer of IRC_FOOTERS) body = body.replace(footer, "");
	return { from, body: body.trim() };
}

/** `[IRC \`a\` → \`b\`]` (relay) and `[IRC you → \`b\` (auto)]` (autoreply) headers. */
const IRC_RELAY_HEADER = /^\[IRC (?:`([^`]+)`|you) → `([^`]+)`(?: \(auto\))?\]\s*/;

function parseIrc(customType: string, details: unknown, text: string): Notice {
	const mode: IrcMode = customType === "irc:incoming" ? "incoming" : customType === "irc:autoreply" ? "autoreply" : "relay";
	const parsed = IrcDetails.safeParse(details);
	const record = parsed.success ? parsed.data : {};
	let from = record.from ?? null;
	let to = record.to ?? null;
	let body = (mode === "incoming" ? record.message : record.body) ?? null;
	if (body === null) {
		const irc = parseIrcText(text);
		const relay = irc ? null : IRC_RELAY_HEADER.exec(text);
		from ??= irc?.from ?? relay?.[1] ?? null;
		to ??= relay?.[2] ?? null;
		body = irc ? irc.body : relay ? text.slice(relay[0].length) : stripNoticeMarkup(text);
	}
	return { kind: "irc", mode, from, to, body: body.trim() };
}

// ─── launch-completion ─────────────────────────────────────────────────────

const LAUNCH_SENTENCE = /^Supervised process (\S+) (\S+) (?:with exit code (-?\d+)|without an exit code)\.$/;

function parseLaunch(details: unknown, text: string): Notice {
	const parsed = LaunchDetails.safeParse(details);
	const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
	if (parsed.success) {
		return {
			kind: "launch",
			processes: parsed.data.daemons.map((daemon, index) => {
				const exitCode = daemon.exitCode ?? null;
				return {
					name: daemon.name ?? "",
					exitCode,
					failed: daemon.state === "failed" || (exitCode !== null && exitCode !== 0),
					text: lines[index] ?? "",
				};
			}),
		};
	}
	return {
		kind: "launch",
		processes: lines.map(line => {
			const match = LAUNCH_SENTENCE.exec(line);
			const exitCode = match?.[3] !== undefined ? Number(match[3]) : null;
			return { name: match?.[1] ?? "", exitCode, failed: match?.[2] === "failed" || (exitCode !== null && exitCode !== 0), text: line };
		}),
	};
}

// ─── advisor ───────────────────────────────────────────────────────────────

function parseAdvisor(details: unknown, text: string): Notice {
	const parsed = AdvisorDetails.safeParse(details);
	if (parsed.success) {
		return {
			kind: "advisor",
			notes: parsed.data.notes.map(note => ({ note: note.note, severity: note.severity ?? null, advisor: note.advisor ?? null })),
		};
	}
	const blocks = [...text.matchAll(/<advisory\b([^>]*)>\n?([\s\S]*?)\n?<\/advisory>/g)];
	if (blocks.length === 0) return { kind: "advisor", notes: text.trim() ? [{ note: text.trim(), severity: null, advisor: null }] : [] };
	return {
		kind: "advisor",
		notes: blocks.map(block => {
			const severity = Severity.safeParse(attr(block[1] ?? "", "severity"));
			return {
				note: unescapeXml(block[2] ?? "").trim(),
				severity: severity.success ? severity.data : null,
				advisor: attr(block[1] ?? "", "advisor"),
			};
		}),
	};
}

// ─── skill-prompt ──────────────────────────────────────────────────────────

const SKILL_HEADER = /^\[IMPORTANT: User invoked the "([^"]+)" skill; follow its instructions\. Full skill below\.\]\s*/;
const SKILL_FOOTER = /\n+---\n+\[Skill directory: [^\n]*\]\n[^\n]*(?:\nUser: ([\s\S]*))?\s*$/;

function parseSkill(details: unknown, text: string): Notice {
	const parsed = SkillDetails.safeParse(details);
	const record = parsed.success ? parsed.data : {};
	const header = SKILL_HEADER.exec(text);
	let body = header ? text.slice(header[0].length) : text;
	const footer = SKILL_FOOTER.exec(body);
	if (footer) body = body.slice(0, footer.index);
	const args = record.args ?? footer?.[1]?.trim() ?? null;
	return {
		kind: "skill",
		name: record.name ?? header?.[1] ?? "",
		args: args ? args.replace(/\s+/g, " ").trim() : null,
		path: record.path ?? null,
		text: body.trim(),
	};
}

// ─── fallback ──────────────────────────────────────────────────────────────

/**
 * omp's model-facing markup removed from `text`, leaving what the notice says: the `<system-notice>` wrapper and its
 * "Background job … has completed" header, `<task-result>` envelopes reduced to their output, `<irc>` blocks
 * reduced to the message, `<advisory>` and `<system-reminder>` tags, and omp's follow-up instructions to the model.
 */
export function stripNoticeMarkup(text: string): string {
	let out = text;
	out = out.replace(/^\[Wait interrupted by message\]\s*/, "");
	out = out.replace(/<\/?system-(?:notice|reminder)>\n?/g, "");
	out = out.replace(/^\s*(?:Background job \S+ has completed\. Resume your work using the result below\.|\d+ background jobs have completed\. Resume your work using the results below\.)[^\S\n]*\n?/, "");
	out = out.replace(/<task-result\b[\s\S]*?(?:<\/task-result>|$)/g, block => parseTaskResult(block)?.result ?? "");
	out = out.replace(/<irc\b[^>]*>\n?[\s\S]*?\n?<\/irc>/g, block => parseIrcText(block)?.body ?? "");
	out = out.replace(/<\/?advisory\b[^>]*>\n?/g, "");
	out = out.replace(IDLE_HINT, "");
	for (const footer of IRC_FOOTERS) out = out.replace(footer, "");
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

// ─── entry point ───────────────────────────────────────────────────────────

const cache = new WeakMap<object, Notice>();

/** A displayed `custom_message` as a typed notice. Cached per entry object (session entries are immutable). */
export function parseNotice(entry: NoticeSource): Notice {
	const cached = cache.get(entry);
	if (cached) return cached;
	const text = contentText(entry.content);
	let notice: Notice;
	switch (entry.customType) {
		case "tsp-notice":
			notice = { kind: "other", text };
			break;
		case "async-result":
			notice = { kind: "jobs", jobs: parseJobs(entry.details, text) };
			break;
		case "irc:incoming":
		case "irc:autoreply":
		case "irc:relay":
			notice = parseIrc(entry.customType, entry.details, text);
			break;
		case "launch-completion":
			notice = parseLaunch(entry.details, text);
			break;
		case "advisor":
			notice = parseAdvisor(entry.details, text);
			break;
		case "skill-prompt":
			notice = parseSkill(entry.details, text);
			break;
		default:
			notice = { kind: "other", text: stripNoticeMarkup(text) };
	}
	cache.set(entry, notice);
	return notice;
}

/**
 * Row-style notices (background jobs, process exits, unknown notices) read as tool steps, so consecutive ones stack
 * like the rows of a tool group; IRC and advisor cards and the skill row keep the chat's row gap.
 */
export function noticeIsStep(notice: Notice): boolean {
	return notice.kind === "jobs" || notice.kind === "launch" || notice.kind === "other";
}

/** Whether the notice has anything to show (an unknown notice with no text after stripping has nothing). */
export function noticeVisible(notice: Notice): boolean {
	switch (notice.kind) {
		case "jobs":
			return notice.jobs.length > 0;
		case "launch":
			return notice.processes.length > 0;
		case "advisor":
			return notice.notes.length > 0;
		case "irc":
		case "skill":
			return true;
		case "other":
			return notice.text !== "";
	}
}

export type JobPayload = { kind: "json" | "code" | "markdown" | "empty"; text: string };

/**
 * How to show a job's result: JSON pretty-printed as a JSON block, command output as a plain code block (its
 * characters mean nothing as Markdown), anything else from a helper as Markdown.
 */
export function jobPayload(job: JobNotice): JobPayload {
	const text = (job.result ?? "").trim();
	if (text === "") return { kind: "empty", text: "" };
	if (/^[[{]/.test(text)) {
		try {
			return { kind: "json", text: JSON.stringify(JSON.parse(text), null, 2) };
		} catch {
			// Not JSON after all (a preview cut mid-object, or prose that starts with a bracket).
		}
	}
	return { kind: job.type === "task" ? "markdown" : "code", text };
}

/** `text` as a fenced Markdown code block whose fence outlasts any backtick run inside it. */
export function fenced(text: string, lang = ""): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
	const fence = "`".repeat(longest + 1);
	return `${fence}${lang}\n${text}\n${fence}`;
}

/** The first non-empty line of `text`, whitespace collapsed. */
export function firstLine(text: string): string {
	return text.split("\n").find(line => line.trim() !== "")?.replace(/\s+/g, " ").trim() ?? "";
}

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** One line for a job: "Background job finished", "Helper “X” failed". `t` reads the `chat` namespace. */
export function jobTitle(job: JobNotice, t: Translate): string {
	const outcome = job.status === "ok" ? "finished" : job.status === "failed" ? "failed" : "stopped";
	if (job.type === "task") return t(`notice.job.helper.${outcome}`, { name: job.label ?? job.id });
	return t(`notice.job.command.${outcome}`);
}

/** One sentence for a process exit, from omp's details when known. */
export function processText(process: ProcessExit, t: Translate): string {
	if (!process.name) return process.text;
	if (process.exitCode === null) return t("notice.launch.noCode", { name: process.name });
	return t(process.failed ? "notice.launch.failed" : "notice.launch.exited", { name: process.name, code: process.exitCode });
}

/** A one-line summary for previews such as the session tree. `t` reads the `chat` namespace. */
export function noticeSummary(notice: Notice, t: Translate): string {
	switch (notice.kind) {
		case "jobs":
			if (notice.jobs.length === 1) return jobTitle(notice.jobs[0]!, t);
			return t("notice.job.batch", { count: notice.jobs.length });
		case "irc": {
			const title = ircTitle(notice, t);
			const body = firstLine(notice.body);
			return body ? `${title}: ${body}` : title;
		}
		case "launch":
			return notice.processes.map(process => processText(process, t)).join(" ");
		case "advisor":
			return `${t("notice.advisor.title")}: ${firstLine(notice.notes[0]?.note ?? "")}`;
		case "skill":
			return t("notice.skill.used", { name: notice.name });
		case "other":
			return firstLine(notice.text);
	}
}

export function ircTitle(notice: Extract<Notice, { kind: "irc" }>, t: Translate): string {
	const unknown = t("notice.irc.unknown");
	if (notice.mode === "incoming") return t("notice.irc.from", { from: notice.from ?? unknown });
	if (notice.mode === "autoreply") return t("notice.irc.autoreply", { to: notice.to ?? unknown });
	return t("notice.irc.relay", { from: notice.from ?? unknown, to: notice.to ?? unknown });
}

/**
 * Side-channel notices keep omp's wording and stay outside the messages sent to the model. visual-omp shows only the
 * latest recap, and only while it is newer than the chat's last message (`lastMessageAt`, ms): a later message
 * supersedes it.
 */
export function hostNotices(notices: readonly HostNotice[] | undefined, lastMessageAt: number | null = null): readonly HostNotice[] {
	if (!notices?.length) return [];
	const seen = new Set<string>();
	const unique = notices.filter(notice => {
		if (!notice.text.trim() || seen.has(notice.id)) return false;
		seen.add(notice.id);
		return true;
	}).sort((left, right) => left.timestamp - right.timestamp);
	const recap = unique.findLast(notice => notice.kind === "recap");
	return unique.filter(notice => notice.kind !== "recap" || (notice === recap && (lastMessageAt === null || notice.timestamp > lastMessageAt)));
}

/**
 * Newest user or assistant message time (ms) on any branch, including a reply still streaming. Every branch counts, so
 * rewinding to before a superseded recap does not bring it back.
 */
export function latestMessageAt(entries: readonly { type?: unknown; timestamp?: unknown; message?: unknown }[] | null | undefined, streamingAt: number | null = null): number | null {
	let latest = streamingAt;
	for (const entry of entries ?? []) {
		if (entry.type !== "message") continue;
		const role = (entry.message as { role?: unknown } | null | undefined)?.role;
		if (role !== "user" && role !== "assistant") continue;
		const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		if (!Number.isNaN(at) && (latest === null || at > latest)) latest = at;
	}
	return latest;
}
