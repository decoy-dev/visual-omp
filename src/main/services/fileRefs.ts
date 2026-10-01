import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { FileRef, FileRefRequest } from "@shared/contracts/fileRefs";

export interface FileRefLimits {
	refs: number;
	bases: number;
	/** Folders named earlier in the request that a relative reference is also tried in. */
	namedFolders: number;
	/** Longest reference or base, in characters. */
	length: number;
}

/** Hard limits for {@link resolveFileRefs}, so a long reply stays a bounded number of stats. */
export const FILE_REF_LIMITS: Readonly<FileRefLimits> = { refs: 100, bases: 8, namedFolders: 4, length: 1024 };

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

/**
 * Resolves file and folder names from a reply (`fs:resolveRefs`). An absolute or `~/` reference is checked as it
 * stands. A relative one is tried in the folders that earlier references resolved to (latest first), then in each
 * base in order, and the first regular file or folder wins. It only stats; content is never read. `limits` is a test
 * seam.
 */
export async function resolveFileRefs(request: unknown, home: string, limits: Readonly<FileRefLimits> = FILE_REF_LIMITS): Promise<(FileRef | null)[]> {
	if (!isRequest(request, limits)) throw new Error("Invalid file references");
	const bases = [...new Set(request.bases.map(base => resolve(isHomePath(base) ? join(home, base.slice(1)) : base)))];
	const named: string[] = [];
	const results: (FileRef | null)[] = [];
	for (const ref of request.refs) {
		const candidates = isHomePath(ref)
			? [join(home, ref.slice(1))]
			: isAbsolute(ref)
				? [resolve(ref)]
				: [...new Set([...named, ...bases].map(base => resolve(base, ref)))];
		const found = (await Promise.all(candidates.map(check))).find(result => result !== null) ?? null;
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
