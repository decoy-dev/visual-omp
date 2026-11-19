import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { createContext } from "react";
import { MAX_TOOL_BASES } from "./fileRefs";

/** Chat and reply-specific folders used to resolve file references in one transcript. */
export interface FileRefScope {
	/** Identifies the chat (its tab), so replies in different chats never share results. */
	chat: string;
	/** The chat folder, tried before tool folders from earlier in the session. */
	bases: readonly string[];
	/** Earlier tool folders, keyed by the timestamp of the reply being resolved. */
	toolBasesByReply?: ReadonlyMap<number, readonly string[]>;
	canonicalProjectPath?: string | null;
}

export const FileRefContext = createContext<FileRefScope | null>(null);
const FILE_PATH_TOOLS = new Set(["read", "write", "edit", "apply_patch"]);
const FOLDER_PATH_TOOLS = new Set(["glob", "grep", "search", "find", "ls", "tree"]);

interface ParsedPath {
	root: string;
	segments: string[];
}

function parseAbsolutePath(path: string, windows: boolean): ParsedPath | null {
	if (!path || path.length > 1024 || path.includes("\0") || /^[\\/]{2}/.test(path)) return null;
	const value = windows ? path.replaceAll("\\", "/") : path;
	const root = windows ? /^[A-Za-z]:\//.test(value) ? `${value.slice(0, 2)}/` : null : value.startsWith("/") ? "/" : null;
	if (!root) return null;
	const segments: string[] = [];
	for (const segment of value.slice(root.length).split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	return { root, segments };
}

function samePath(left: string, right: string, windows: boolean): boolean {
	return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function folderCandidates(path: string, directory: boolean, home: string, windows: boolean): string[] {
	const parsed = parseAbsolutePath(path, windows);
	const homePath = parseAbsolutePath(home, windows);
	if (!parsed || !homePath) return [];
	if (!directory) parsed.segments.pop();
	const homeName = samePath(parsed.root, homePath.root, windows) ? homePath.root + homePath.segments.join("/") : null;
	const folders: string[] = [];
	while (parsed.segments.length > 0) {
		const folder = parsed.root + parsed.segments.join("/");
		if (homeName && samePath(folder, homeName, windows)) break;
		folders.push(folder);
		parsed.segments.pop();
	}
	if (folders.length <= MAX_TOOL_BASES) return folders;
	return [...folders.slice(0, 3), ...folders.slice(-4)];
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toolBasesForCall(name: string, args: Record<string, unknown>, home: string, windows: boolean): string[] {
	const folders: string[] = [];
	const add = (value: unknown, directory: boolean) => {
		if (typeof value === "string") folders.push(...folderCandidates(value, directory || /[\\/]$/.test(value), home, windows));
	};
	if (name === "bash") add(args.cwd, true);
	else if (FILE_PATH_TOOLS.has(name)) {
		add(args.path, false);
		add(args.file_path, false);
	} else if (FOLDER_PATH_TOOLS.has(name)) add(args.path, true);
	return folders;
}

function addToolBases(current: readonly string[], next: readonly string[], windows: boolean): readonly string[] {
	if (next.length === 0) return current;
	const bases = [...current];
	for (let index = next.length - 1; index >= 0; index--) {
		const candidate = next[index]!;
		const duplicate = bases.findIndex(base => samePath(base, candidate, windows));
		if (duplicate >= 0) bases.splice(duplicate, 1);
		bases.unshift(candidate);
		if (bases.length > MAX_TOOL_BASES) bases.length = MAX_TOOL_BASES;
	}
	return bases;
}

/** Earlier absolute tool paths contribute a bounded set of ancestor folders to each later reply. */
export function toolBasesByReply(entries: readonly SessionEntry[], home: string | null, platform: string, streamTimestamp?: number): ReadonlyMap<number, readonly string[]> {
	const byReply = new Map<number, readonly string[]>();
	if (!home) return byReply;
	const windows = platform === "win32";
	let bases: readonly string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		byReply.set(entry.message.timestamp, bases);
		if (!Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall") continue;
			const args = record(block.arguments);
			if (args) bases = addToolBases(bases, toolBasesForCall(block.name, args, home, windows), windows);
		}
	}
	if (streamTimestamp !== undefined) byReply.set(streamTimestamp, bases);
	return byReply;
}

