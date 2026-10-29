import type { Dir } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { FileRef, FileRefRequest } from "@shared/contracts/fileRefs";

export interface FileRefLimits {
	refs: number;
	bases: number;
	/** Folders named earlier in the request that a relative reference is also tried in. */
	namedFolders: number;
	/** Longest reference or base, in characters. */
	length: number;
	/** Maximum entries in a folder eligible for abbreviated-name matching. */
	folderEntries: number;
	/** Maximum directory entries read across all abbreviated references, including overflow probes. */
	totalEntries: number;
}

/** Hard limits for {@link resolveFileRefs}, including directory scans for abbreviated names. */
export const FILE_REF_LIMITS: Readonly<FileRefLimits> = { refs: 100, bases: 8, namedFolders: 4, length: 1024, folderEntries: 512, totalEntries: 4096 };

function isPathString(value: unknown, limits: Readonly<FileRefLimits>): value is string {
	// UNC and `//` paths are refused because a stat there can wait on the network.
	return typeof value === "string" && value.length > 0 && value.length <= limits.length && !value.includes("\0") && !/^[\\/]{2}/.test(value);
}

function isHomePath(path: string): boolean {
	return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

function isRequest(value: unknown, limits: Readonly<FileRefLimits>): value is FileRefRequest {
	if (typeof value !== "object" || value === null) return false;
	const { refs, bases } = value as Record<string, unknown>;
	return (
		Array.isArray(refs) &&
		refs.length <= limits.refs &&
		refs.every(ref => isPathString(ref, limits)) &&
		Array.isArray(bases) &&
		bases.length <= limits.bases &&
		bases.every(base => isPathString(base, limits) && (isAbsolute(base) || isHomePath(base)))
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

/**
 * Resolves file and folder names from a reply (`fs:resolveRefs`). An absolute or `~/` reference is checked as it
 * stands. A relative one is tried in the folders that earlier references resolved to (latest first), then in each
 * base in order, and the first regular file or folder wins. Exact names take precedence. Otherwise a last component
 * containing U+2026 is matched in those same parents: the first folder with matches wins only if it has one.
 * Directory scans are bounded, skip hidden entries and symlinks, and never recurse or read content. `limits` is a test seam.
 */
export async function resolveFileRefs(request: unknown, home: string, limits: Readonly<FileRefLimits> = FILE_REF_LIMITS): Promise<(FileRef | null)[]> {
	if (!isRequest(request, limits)) throw new Error("Invalid file references");
	const bases = [...new Set(request.bases.map(base => resolve(isHomePath(base) ? join(home, base.slice(1)) : base)))];
	const named: string[] = [];
	const results: (FileRef | null)[] = [];
	const budget = { remaining: limits.totalEntries };
	for (const ref of request.refs) {
		const candidates = isHomePath(ref)
			? [join(home, ref.slice(1))]
			: isAbsolute(ref)
				? [resolve(ref)]
				: [...new Set([...named, ...bases].map(base => resolve(base, ref)))];
		let found = (await Promise.all(candidates.map(check))).find(result => result !== null) ?? null;
		if (!found && basename(ref).includes("…")) {
			for (const candidate of candidates) {
				const result = await abbreviated(candidate, limits, budget);
				if (result.matches > 0) {
					found = result.ref;
					break;
				}
			}
		}
		results.push(found);
		if (found?.kind === "folder") {
			const at = named.indexOf(found.path);
			if (at >= 0) named.splice(at, 1);
			named.unshift(found.path);
			named.length = Math.min(named.length, limits.namedFolders);
		}
	}
	return results;
}
