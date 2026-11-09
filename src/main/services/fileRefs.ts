import type { Dir } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { FileRef, FileRefRequest } from "@shared/contracts/fileRefs";

export interface FileRefLimits {
	refs: number;
	bases: number;
	files: number;
	/** Directory references in the same reply that a relative reference is also tried in. */
	namedFolders: number;
	/** Longest reference or base, in characters. */
	length: number;
	/** Maximum entries in a folder eligible for abbreviated-name matching. */
	folderEntries: number;
	/** Maximum directory entries read across all abbreviated references, including overflow probes. */
	totalEntries: number;
}

/** Hard limits for {@link resolveFileRefs}, including directory scans for abbreviated names. */
export const FILE_REF_LIMITS: Readonly<FileRefLimits> = { refs: 100, bases: 8, files: 100, namedFolders: 4, length: 1024, folderEntries: 512, totalEntries: 4096 };

function isPathString(value: unknown, limits: Readonly<FileRefLimits>): value is string {
	// UNC and `//` paths are refused because a stat there can wait on the network.
	return typeof value === "string" && value.length > 0 && value.length <= limits.length && !value.includes("\0") && !/^[\\/]{2}/.test(value);
}

function isHomePath(path: string): boolean {
	return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

function isRequest(value: unknown, limits: Readonly<FileRefLimits>): value is FileRefRequest {
	if (typeof value !== "object" || value === null) return false;
	const { refs, bases, files } = value as Record<string, unknown>;
	return (
		Array.isArray(refs) &&
		refs.length <= limits.refs &&
		refs.every(ref => isPathString(ref, limits)) &&
		Array.isArray(bases) &&
		bases.length <= limits.bases &&
		bases.every(base => isPathString(base, limits) && (isAbsolute(base) || isHomePath(base))) &&
		(files === undefined || Array.isArray(files) && files.length <= limits.files && files.every(file => isPathString(file, limits) && (isAbsolute(file) || isHomePath(file))))
	);
}

/** A regular file or folder at `path`, after resolving symlinks; null for anything else or nothing. */
async function check(path: string): Promise<FileRef | null> {
	try {
		const real = await realpath(path);
		const info = await stat(real);
		if (info.isFile()) return { path: real, kind: "file" };
		if (info.isDirectory()) return { path: real, kind: "folder" };
		return null;
	} catch {
		return null;
	}
}

/** U+2026 is an abbreviation; three ASCII periods remain literal filename characters. */
function matchesAbbreviation(name: string, parts: readonly string[]): boolean {
	const prefix = parts[0] ?? "";
	const suffix = parts.at(-1) ?? "";
	if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
	let after = prefix.length;
	const end = name.length - suffix.length;
	for (const part of parts.slice(1, -1)) {
		const at = name.indexOf(part, after);
		if (at < 0 || at + part.length > end) return false;
		after = at + part.length;
	}
	return after <= end;
}

/**
 * Lists one parent without recursion or content reads. A bounded directory handle avoids allocating a huge
 * readdir array. One overflow entry proves the folder too large; its partial matches are discarded.
 */
async function abbreviated(
	path: string,
	limits: Readonly<FileRefLimits>,
	budget: { remaining: number },
): Promise<{ matches: number; ref: FileRef | null }> {
	const none = { matches: 0, ref: null };
	const folder = dirname(path);
	const name = basename(path);
	if (!name.includes("…") || basename(folder).startsWith(".") || budget.remaining <= 0) return none;
	const parts = name.split("…");
	// A bare ellipsis carries no visible filename information.
	if (parts.every(part => part === "")) return none;
	let directory: Dir | undefined;
	try {
		directory = await opendir(folder, { bufferSize: 1 });
		const matches: string[] = [];
		let count = 0;
		while (true) {
			if (budget.remaining <= 0) return none;
			const entry = await directory.read();
			if (!entry) break;
			budget.remaining--;
			if (++count > limits.folderEntries) return none;
			if (entry.name.startsWith(".") || (!entry.isFile() && !entry.isDirectory())) continue;
			if (matchesAbbreviation(entry.name, parts) && matches.length < 2) matches.push(entry.name);
		}
		if (matches.length !== 1) return { matches: matches.length, ref: null };
		return { matches: 1, ref: await check(join(folder, matches[0]!)) };
	} catch {
		return none;
	} finally {
		await directory?.close().catch(() => {});
	}
}

/** Path separators on this platform: a backslash is an ordinary filename character outside Windows. */
const SEPARATORS = process.platform === "win32" ? /[\\/]/ : /\//;

/**
 * Where a relative reference may point from `parents`: inside each parent, then, for a parent whose own name starts
 * the reference, inside that parent without the repeated name. Replies often name a file from the folder above the
 * chat's, as `DEEL Two Sheeter/overview.pdf` from inside `DEEL Two Sheeter`. The shortened form is skipped when the
 * rest climbs with `..`, so it cannot reach a sibling folder.
 */
function relativeCandidates(ref: string, parents: readonly string[], repeated = false): string[] {
	if (!repeated) return [...new Set(parents.map(parent => resolve(parent, ref)))];
	const [first, ...rest] = ref.split(SEPARATORS);
	const shortened = rest.length > 0 && !rest.includes("..");
	return shortened ? [...new Set(parents.filter(parent => basename(parent) === first).map(parent => resolve(parent, ...rest)))] : [];
}

/**
 * Resolves reply references through bounded existence checks. Exact relative names must identify one canonical
 * target across named directories, chat bases and matching known Outputs paths. Directory spans are checked first
 * so a later span can provide context too. Abbreviations keep their existing bounded first-folder lookup.
 */
export async function resolveFileRefs(request: unknown, home: string, limits: Readonly<FileRefLimits> = FILE_REF_LIMITS): Promise<(FileRef | null)[]> {
	if (!isRequest(request, limits)) throw new Error("Invalid file references");
	const bases = [...new Set(request.bases.map(base => resolve(isHomePath(base) ? join(home, base.slice(1)) : base)))];
	const files = [...new Set((request.files ?? []).map(file => resolve(isHomePath(file) ? join(home, file.slice(1)) : file)))];
	const fileFolders = new Set(files.map(dirname));
	const knownPaths = [...new Set([...files, ...fileFolders])];
	const named: string[] = [];
	const checked = new Map<string, Promise<FileRef | null>>();
	const exact = async (candidates: readonly string[]) => {
		const matches = new Map<string, FileRef>();
		for (const candidate of new Set(candidates)) {
			let pending = checked.get(candidate);
			if (!pending) { pending = check(candidate); checked.set(candidate, pending); }
			const result = await pending;
			if (result) matches.set(result.path, result);
		}
		return { count: matches.size, ref: matches.size === 1 ? matches.values().next().value ?? null : null };
	};
	const candidatesFor = (ref: string, parents: readonly string[]): string[] => {
		if (isHomePath(ref)) return [join(home, ref.slice(1))];
		if (isAbsolute(ref)) return [resolve(ref)];
		const parts = ref.split(SEPARATORS).filter(part => part !== "" && part !== ".");
		const suffix = parts.join(sep);
		const key = process.platform === "win32" ? suffix.toLowerCase() : suffix;
		const known = parts.includes("..") || !suffix ? [] : knownPaths.filter(file => {
			if (/[\\/]$/.test(ref) && !fileFolders.has(file)) return false;
			const path = process.platform === "win32" ? file.toLowerCase() : file;
			return path.endsWith(`${sep}${key}`);
		});
		return [...relativeCandidates(ref, parents), ...known];
	};
	const lookup = async (ref: string, parents: readonly string[]) => {
		const candidates = candidatesFor(ref, parents);
		let match = await exact(candidates);
		if (match.count === 0 && !isAbsolute(ref) && !isHomePath(ref)) {
			const repeated = relativeCandidates(ref, parents, true);
			match = await exact(repeated);
			candidates.push(...repeated);
		}
		return { ...match, candidates };
	};
	const remember = (folder: string) => {
		const at = named.indexOf(folder);
		if (at >= 0) named.splice(at, 1);
		named.unshift(folder);
		named.length = Math.min(named.length, limits.namedFolders);
	};
	for (const ref of request.refs) {
		if (/^out:\/\//i.test(ref)) continue;
		const found = await lookup(ref, bases);
		if (found.ref?.kind === "folder") remember(found.ref.path);
	}
	const results: (FileRef | null)[] = [];
	const budget = { remaining: limits.totalEntries };
	for (const ref of request.refs) {
		if (/^out:\/\//i.test(ref)) { results.push(null); continue; }
		const match = await lookup(ref, [...named, ...bases]);
		let found = match.ref;
		if (match.count === 0 && basename(ref).includes("…")) {
			for (const candidate of match.candidates) {
				const result = await abbreviated(candidate, limits, budget);
				if (result.matches > 0) { found = result.ref; break; }
			}
		}
		results.push(found);
		if (found?.kind === "folder") remember(found.path);
	}
	return results;
}
