/**
 * Helpers for omp 19.1+'s bash tool commands (`details.toolCommands`) and bash-emitted image paths.
 *
 * When `bash` is active, omp 19.1+ dispatches discoverable tools (`generate_image`, `ast_edit`, `lsp`,
 * `fetch`, `github`, `resolve`, `reject`, `propose`, `report_issue`, etc.) as shell commands and records
 * each invocation in `details.toolCommands` on both partial updates and final results.
 */
import type { ToolResultBlock, ToolResultLike } from "./types";
import { isRecord, num, str } from "./util";

export interface ToolCommandRecord {
	tool: string;
	mode: "help" | "execute";
	exitCode: number;
	args: Record<string, unknown>;
	inner: unknown;
}

/** Parse `details.toolCommands` from a bash result or partial update. */
export function toolCommandRecords(result: { details?: unknown } | undefined): ToolCommandRecord[] {
	const details = isRecord(result?.details) ? result.details : null;
	if (!details || !Array.isArray(details.toolCommands)) return [];
	const records: ToolCommandRecord[] = [];
	for (const entry of details.toolCommands) {
		if (!isRecord(entry)) continue;
		const tool = str(entry.tool);
		const mode = entry.mode === "help" || entry.mode === "execute" ? entry.mode : null;
		const exitCode = num(entry.exitCode);
		if (!tool || !mode || exitCode === null) continue;
		records.push({
			tool,
			mode,
			exitCode,
			args: isRecord(entry.args) ? entry.args : {},
			inner: entry.inner,
		});
	}
	return records;
}

/**
 * Move a bash result's images to its nested `generate_image` card only when they provably came from that call: the
 * command is one `generate_image` invocation and the image count matches the call's `imageCount` (omp's
 * `generate_image` details). In any other command a pipe or redirection can drop the call's images while another
 * program prints its own, so the images stay on the bash card (`remaining`).
 */
export function partitionToolCommandImages(
	command: string | null | undefined,
	result: ToolResultLike | undefined,
	records: readonly ToolCommandRecord[],
): { byIndex: Map<number, ToolResultBlock[]>; remaining: ToolResultBlock[] } {
	const byIndex = new Map<number, ToolResultBlock[]>();
	const outerImages: ToolResultBlock[] = [];
	if (result) {
		for (const block of result.content) {
			const record = isRecord(block as unknown) ? (block as Record<string, unknown>) : null;
			if (record && record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
				outerImages.push(block);
			}
		}
	}
	if (outerImages.length === 0) return { byIndex, remaining: [] };
	const record = records.length === 1 ? records[0]! : undefined;
	const inner = record && isRecord(record.inner) ? record.inner : null;
	const declared = num(inner?.imageCount) ?? (Array.isArray(inner?.imagePaths) ? inner.imagePaths.length : null);
	if (record?.mode !== "execute" || record.tool !== "generate_image" || declared !== outerImages.length || !isSoleInvocation(command, "generate_image")) {
		return { byIndex, remaining: outerImages };
	}
	byIndex.set(0, outerImages);
	return { byIndex, remaining: [] };
}

/** Paths announced by omp 19.1+ bash image output (`Image saved: <path>`). */
export function extractSavedImagePaths(text: string): string[] {
	const paths: string[] = [];
	for (const match of text.matchAll(/^Image saved: (.+)$/gm)) {
		const path = match[1]?.trim();
		if (path) paths.push(path);
	}
	return paths;
}

/** True when a shell command starts (after optional `cd` / env assignments) by invoking `tool`. */
export function commandLeadsWithTool(command: string, tool: string): boolean {
	const stripped = command
		.trim()
		.replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*)*/u, "")
		.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/u, "");
	const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}(?:\\s|$)`).test(stripped);
}

const SHELL_COMPOUND_CHARS = new Set(["|", "&", ";", "<", ">", "(", ")", "$", "`", "\n"]);

/** Whether `command` is one simple invocation of `tool`: no pipes, lists, redirections or substitutions. */
export function isSoleInvocation(command: string | null | undefined, tool: string): boolean {
	const line = command?.trim();
	if (!line || (line !== tool && !line.startsWith(`${tool} `) && !line.startsWith(`${tool}\t`))) return false;
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]!;
		if (quote === "'") {
			if (char === "'") quote = undefined;
			continue;
		}
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = undefined;
			else if (char === "$" || char === "`") return false;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (SHELL_COMPOUND_CHARS.has(char)) return false;
	}
	return true;
}
