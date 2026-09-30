/**
 * Plain-language one-liners for tool calls ("Edited 2 files — +8 −3", "Ran `npm test` — passed").
 * Returns an i18n key in the `tools` namespace plus values, so every string stays translatable.
 * Tolerates partial args and missing results: calls stream in before they finish.
 */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { ToolResultLike } from "../tool-render/types";
import { detailsRecord, isRecord, num, resultTextOf, shortenPath, str } from "../tool-render/util";

export type ToolStatus = "running" | "ok" | "error";

export interface FriendlySummary {
	/** Key in `i18n/en/tools.json`. */
	key: string;
	values: Record<string, string | number>;
	status: ToolStatus;
	/** Lines added/removed, shown as colored meta when present. */
	added?: number;
	removed?: number;
}

export interface ToolCallView {
	name: string;
	args: Record<string, unknown>;
	result?: ToolResultLike;
	running: boolean;
	/** Model-provided intent (`i` argument), shown atop the expanded body. */
	intent?: string;
}

/**
 * Normalize a raw tool call the way omp's own renderers do (tool-render/ToolView.tsx): strip the
 * intent argument, and show `write` → `xd://<tool>` device calls as the device tool. A finished
 * call carries the dispatch in `result.details.xdev`; a running one only has the JSON write content.
 */
export function resolveToolCall(raw: { name: string; args: unknown; result?: ToolResultLike; running: boolean; intent?: string }): ToolCallView {
	const source = isRecord(raw.args) ? raw.args : {};
	const args: Record<string, unknown> = {};
	for (const key in source) if (key !== INTENT_FIELD) args[key] = source[key];
	const intent = raw.intent?.trim() || (typeof source[INTENT_FIELD] === "string" ? source[INTENT_FIELD].trim() : undefined) || undefined;
	const call: ToolCallView = { name: raw.name, args, result: raw.result, running: raw.running, intent };
	if (call.name !== "write") return call;
	const xdev = isRecord(raw.result?.details) ? raw.result.details.xdev : undefined;
	if (raw.result && !raw.result.isError && isRecord(xdev) && xdev.mode === "execute" && typeof xdev.tool === "string") {
		return {
			...call,
			name: xdev.tool,
			args: isRecord(xdev.args) ? xdev.args : {},
			result: { content: raw.result.content, details: xdev.inner, isError: raw.result.isError },
		};
	}
	const match = /^xd:\/\/([a-z0-9_]+)/i.exec(str(args.path) ?? "");
	if (!match?.[1]) return call;
	let deviceArgs: Record<string, unknown> = {};
	const content = str(args.content);
	if (content) {
		try {
			const parsed: unknown = JSON.parse(content);
			if (isRecord(parsed)) deviceArgs = parsed;
		} catch {}
	}
	return { ...call, name: match[1], args: deviceArgs };
}

function baseName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

function firstLine(text: string, max = 60): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function diffCounts(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** Hashline `[path#TAG]` and apply_patch `*** Update File: path` headers in an edit input. */
function editInputPaths(input: string): string[] {
	const paths: string[] = [];
	for (const raw of input.split("\n")) {
		const line = raw.trim();
		const hashline = /^\[(.+?)(?:#[0-9a-fA-F]{4})?\]$/.exec(line);
		const patch = /^\*{3} (?:Update|Add|Delete) File:\s*(.+)$/.exec(line);
		const path = hashline?.[1] ?? patch?.[1];
		if (path && !paths.includes(path)) paths.push(path);
	}
	return paths;
}

function statusOf(call: ToolCallView): ToolStatus {
	if (call.running && !call.result) return "running";
	return call.result?.isError ? "error" : "ok";
}

function editSummary(call: ToolCallView, status: ToolStatus): FriendlySummary {
	const details = detailsRecord(call.result);
	const perFile = details && Array.isArray(details.perFileResults) ? details.perFileResults.filter(isRecord) : [];
	const entries = perFile.length > 0 ? perFile : details ? [details] : [];
	const paths = entries.map(entry => str(entry.path)).filter((path): path is string => path !== null);
	const fromInput = editInputPaths(str(call.args.input) ?? "");
	const files = paths.length > 0 ? paths : fromInput.length > 0 ? fromInput : [str(call.args.path) ?? ""].filter(Boolean);
	let added = 0;
	let removed = 0;
	for (const entry of entries) {
		const counts = diffCounts(str(entry.diff) ?? "");
		added += counts.added;
		removed += counts.removed;
	}
	const counts = status === "ok" && added + removed > 0 ? { added, removed } : {};
	if (files.length > 1) return { key: `edit.many.${status}`, values: { count: files.length }, status, ...counts };
	return { key: `edit.one.${status}`, values: { file: baseName(files[0] ?? "") }, status, ...counts };
}

function bashSummary(call: ToolCallView, status: ToolStatus): FriendlySummary {
	const command = firstLine(str(call.args.command) ?? "");
	const details = detailsRecord(call.result);
	const exitCode = num(details?.exitCode);
	if (status === "running") return { key: "bash.running", values: { command }, status };
	if (details && isRecord(details.async)) return { key: "bash.background", values: { command }, status };
	if (status === "error" || (exitCode !== null && exitCode !== 0)) {
		return { key: "bash.failed", values: { command, code: exitCode ?? 1 }, status: "error" };
	}
	return { key: "bash.passed", values: { command }, status };
}

function taskSummary(call: ToolCallView, status: ToolStatus): FriendlySummary {
	const tasks = Array.isArray(call.args.tasks) ? call.args.tasks.filter(isRecord) : [];
	const count = Math.max(1, tasks.length);
	const agent = str(call.args.agent) ?? str(tasks[0]?.agent) ?? "task";
	if (count === 1) return { key: `task.one.${status}`, values: { agent }, status };
	return { key: `task.many.${status}`, values: { count }, status };
}

function todoSummary(call: ToolCallView, status: ToolStatus): FriendlySummary {
	const details = detailsRecord(call.result);
	const phases = details && Array.isArray(details.phases) ? details.phases.filter(isRecord) : [];
	let done = 0;
	let total = 0;
	for (const phase of phases) {
		const tasks = Array.isArray(phase.tasks) ? phase.tasks.filter(isRecord) : [];
		total += tasks.length;
		done += tasks.filter(task => task.status === "completed" || task.status === "done").length;
	}
	if (total === 0) return { key: "todo.updated", values: {}, status };
	return { key: "todo.progress", values: { done, total }, status };
}

function evalSummary(call: ToolCallView, status: ToolStatus): FriendlySummary {
	const cells = Array.isArray(call.args.cells) ? call.args.cells.filter(isRecord) : [];
	const code = [str(call.args.code), str(call.args.input), ...cells.map(cell => str(cell.code))].filter(Boolean).join("\n");
	const language = str(call.args.language) ?? str(cells[0]?.language) ?? (call.name === "js" ? "js" : "py");
	if (/\bbrowser\.(open|tab)\b/.test(code)) return { key: `eval.browser.${status}`, values: {}, status };
	if (/\bcomputer\.(window|run|screenshot)\b/.test(code)) return { key: `eval.computer.${status}`, values: {}, status };
	return { key: `eval.${/^(js|javascript|ts)$/i.test(language) ? "js" : "py"}.${status}`, values: {}, status };
}

/** Plain-language summary of one resolved tool call (see `resolveToolCall`). Unknown tools fall back to "Used <name>". */
export function friendlySummary(call: ToolCallView): FriendlySummary {
	const status = statusOf(call);
	const args = call.args;
	switch (call.name) {
		case "edit":
		case "apply_patch":
			return editSummary(call, status);
		case "write": {
			const path = str(args.file_path) ?? str(args.path) ?? "";
			const lines = (str(args.content) ?? "").split("\n").length;
			return { key: `write.${status}`, values: { file: baseName(path), lines }, status };
		}
		case "read": {
			const path = str(args.path) ?? str(args.file_path) ?? "";
			if (/^https?:\/\//i.test(path)) return { key: `read.url.${status}`, values: { url: firstLine(path, 50) }, status };
			return { key: `read.file.${status}`, values: { file: shortenPath(baseName(path) || path) }, status };
		}
		case "grep":
		case "search":
		case "ast_grep":
			return { key: `search.${status}`, values: { pattern: firstLine(str(args.pattern) ?? "", 40) }, status };
		case "glob":
		case "find":
			return { key: `find.${status}`, values: { pattern: firstLine(str(args.pattern) ?? str(args.query) ?? "", 40) }, status };
		case "bash":
			return bashSummary(call, status);
		case "task":
			return taskSummary(call, status);
		case "todo":
			return todoSummary(call, status);
		case "web_search":
			return { key: `web.${status}`, values: { query: firstLine(str(args.query) ?? "", 50) }, status };
		case "fetch":
			return { key: `fetch.${status}`, values: { url: firstLine(str(args.url) ?? "", 50) }, status };
		case "eval":
		case "python":
		case "js":
		case "notebook":
			return evalSummary(call, status);
		case "ast_edit":
			return { key: `astEdit.${status}`, values: {}, status };
		case "lsp":
			return { key: `lsp.${status}`, values: { action: str(args.action) ?? "" }, status };
		case "ask":
			return { key: `ask.${status}`, values: {}, status };
		case "github":
			return { key: `github.${status}`, values: {}, status };
		case "generate_image":
			return { key: `image.${status}`, values: {}, status };
		case "retain":
		case "learn":
			return { key: `remember.${status}`, values: {}, status };
		case "recall":
		case "reflect":
			return { key: `recall.${status}`, values: {}, status };
		case "checkpoint":
			return { key: `checkpoint.${status}`, values: {}, status };
		case "rewind":
			return { key: `rewind.${status}`, values: {}, status };
		case "wait":
			return { key: `wait.${status}`, values: {}, status };
		default: {
			const text = status === "error" ? firstLine(resultTextOf(call.result), 60) : "";
			return { key: `generic.${status}`, values: { tool: call.name.replace(/^mcp__/, "").replace(/_/g, " "), detail: text }, status };
		}
	}
}
