import type { Dir } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
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
	const { refs, bases, toolBases, files } = value as Record<string, unknown>;
	return (
		Array.isArray(refs) &&
		refs.length <= limits.refs &&
		refs.every(ref => isPathString(ref, limits)) &&
		Array.isArray(bases) &&
		bases.length <= limits.bases &&
		bases.every(base => isPathString(base, limits) && (isAbsolute(base) || isHomePath(base))) &&
		(toolBases === undefined || Array.isArray(toolBases) && toolBases.length + bases.length <= limits.bases && toolBases.every(base => isPathString(base, limits) && (isAbsolute(base) || isHomePath(base)))) &&
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

interface ToolBase {
	path: string;
	realPath: string;
}

interface PathCandidate {
	path: string;
	toolBases?: readonly ToolBase[];
}

function isWithin(parent: string, candidate: string): boolean {
	const fromParent = relative(parent, candidate);
	return fromParent === "" || fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function disallowedToolBase(path: string, realPath: string, home: string, realHome: string): boolean {
	return (
		samePath(path, parse(path).root) ||
		samePath(realPath, parse(realPath).root) ||
		isWithin(path, home) ||
		isWithin(realPath, realHome)
	);
}

/**
 * Resolves reply references through bounded existence checks. Exact relative names first check reply directories,
 * chat bases and matching known Outputs paths. Tool bases are fallback candidates only when those sources have no
 * matches. Abbreviations keep their existing bounded first-folder lookup.
 */
export async function resolveFileRefs(request: unknown, home: string, limits: Readonly<FileRefLimits> = FILE_REF_LIMITS): Promise<(FileRef | null)[]> {
	if (!isRequest(request, limits)) throw new Error("Invalid file references");
	const homePath = resolve(home);
	const realHomePath = await realpath(homePath).catch(() => homePath);
	const bases = [...new Set(request.bases.map(base => resolve(isHomePath(base) ? join(home, base.slice(1)) : base)))];
	const files = [...new Set((request.files ?? []).map(file => resolve(isHomePath(file) ? join(home, file.slice(1)) : file)))];
	const chatParents: PathCandidate[] = bases.map(path => ({ path }));
	const toolBases: ToolBase[] = [];
	for (const requested of request.toolBases ?? []) {
		const path = resolve(isHomePath(requested) ? join(home, requested.slice(1)) : requested);
		if (disallowedToolBase(path, path, homePath, realHomePath) || toolBases.some(base => samePath(base.path, path))) continue;
		const realPath = await realpath(path).catch(() => null);
		if (realPath && !disallowedToolBase(path, realPath, homePath, realHomePath)) toolBases.push({ path, realPath });
	}
	const toolParents: PathCandidate[] = toolBases.map(base => ({ path: base.path, toolBases: [base] }));
	const fileFolders = new Set(files.map(dirname));
	const knownPaths = [...new Set([...files, ...fileFolders])];
	const named: PathCandidate[] = [];
	const checked = new Map<string, Promise<FileRef | null>>();
	const exact = async (candidates: readonly PathCandidate[]) => {
		const matches = new Map<string, { ref: FileRef; toolBases?: ToolBase[] }>();
		for (const candidate of candidates) {
			const lexicalBases = candidate.toolBases?.filter(base => isWithin(base.path, candidate.path));
			if (candidate.toolBases && (!lexicalBases || lexicalBases.length === 0)) continue;
			let pending = checked.get(candidate.path);
			if (!pending) { pending = check(candidate.path); checked.set(candidate.path, pending); }
			const result = await pending;
			if (!result) continue;
			const resultBases = lexicalBases?.filter(base => isWithin(base.realPath, result.path));
			if (candidate.toolBases && (!resultBases || resultBases.length === 0)) continue;
			const previous = matches.get(result.path);
			if (!previous) {
				matches.set(result.path, { ref: result, ...(resultBases ? { toolBases: [...resultBases] } : {}) });
			} else if (previous.toolBases === undefined || resultBases === undefined) {
				previous.toolBases = undefined;
			} else {
				for (const base of resultBases) if (!previous.toolBases.includes(base)) previous.toolBases.push(base);
			}
		}
		const unique = matches.size === 1 ? matches.values().next().value : undefined;
		return { count: matches.size, ref: unique?.ref ?? null, toolBases: unique?.toolBases };
	};
	const candidatesFrom = (ref: string, parents: readonly PathCandidate[], repeated = false): PathCandidate[] => parents.flatMap(parent =>
		relativeCandidates(ref, [parent.path], repeated).map(path => parent.toolBases ? { path, toolBases: parent.toolBases } : { path }),
	);
	const toolAbbreviationBases = async (candidate: PathCandidate): Promise<ToolBase[] | null> => {
		if (!candidate.toolBases) return null;
		const parent = dirname(candidate.path);
		const bases = candidate.toolBases.filter(base => isWithin(base.path, parent));
		if (bases.length === 0) return [];
		const realParent = await realpath(parent).catch(() => null);
		return realParent ? bases.filter(base => isWithin(base.realPath, realParent)) : [];
	};
	const candidatesFor = (ref: string, parents: readonly PathCandidate[]): PathCandidate[] => {
		if (process.platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(ref)) return [];
		if (isHomePath(ref)) return [{ path: join(home, ref.slice(1)) }];
		if (isAbsolute(ref)) return [{ path: resolve(ref) }];
		const parts = ref.split(SEPARATORS).filter(part => part !== "" && part !== ".");
		const suffix = parts.join(sep);
		const key = process.platform === "win32" ? suffix.toLowerCase() : suffix;
		const known = parts.includes("..") || !suffix ? [] : knownPaths.filter(file => {
			if (/[\\/]$/.test(ref) && !fileFolders.has(file)) return false;
			const path = process.platform === "win32" ? file.toLowerCase() : file;
			return path.endsWith(`${sep}${key}`);
		});
		return [...candidatesFrom(ref, parents), ...known.map(path => ({ path }))];
	};
	const lookup = async (ref: string, parents: readonly PathCandidate[]) => {
		const candidates = candidatesFor(ref, parents);
		const driveRelative = process.platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(ref);
		const canUseRelative = !driveRelative && !isAbsolute(ref) && !isHomePath(ref);
		let match = await exact(candidates);
		if (match.count === 0 && canUseRelative) {
			const repeated = candidatesFrom(ref, parents, true);
			candidates.push(...repeated);
			match = await exact(repeated);
		}
		if (match.count === 0 && canUseRelative && toolParents.length > 0) {
			const toolCandidates = candidatesFrom(ref, toolParents);
			candidates.push(...toolCandidates);
			match = await exact(toolCandidates);
			if (match.count === 0) {
				const repeated = candidatesFrom(ref, toolParents, true);
				candidates.push(...repeated);
				match = await exact(repeated);
			}
		}
		return { ...match, candidates };
	};
	const remember = (folder: string, toolBases?: readonly ToolBase[]) => {
		const at = named.findIndex(candidate => samePath(candidate.path, folder));
		let origins = toolBases?.map(base => ({ path: base.realPath, realPath: base.realPath }));
		if (at >= 0) {
			const previous = named.splice(at, 1)[0]!;
			if (previous.toolBases === undefined || origins === undefined) origins = undefined;
			else for (const base of previous.toolBases) if (!origins.some(origin => samePath(origin.path, base.path))) origins.push(base);
		}
		named.unshift(origins ? { path: folder, toolBases: origins } : { path: folder });
		named.length = Math.min(named.length, limits.namedFolders);
	};
	for (const ref of request.refs) {
		if (/^out:\/\//i.test(ref)) continue;
		const found = await lookup(ref, chatParents);
		if (found.ref?.kind === "folder") remember(found.ref.path, found.toolBases);
	}
	const results: (FileRef | null)[] = [];
	const budget = { remaining: limits.totalEntries };
	for (const ref of request.refs) {
		if (/^out:\/\//i.test(ref)) { results.push(null); continue; }
		const match = await lookup(ref, [...named, ...chatParents]);
		let found = match.ref;
		let foundToolBases = match.toolBases;
		if (match.count === 0 && basename(ref).includes("…")) {
			for (const candidate of match.candidates) {
				const safeBases = await toolAbbreviationBases(candidate);
				if (candidate.toolBases && safeBases?.length === 0) continue;
				const result = await abbreviated(candidate.path, limits, budget);
				if (result.matches > 0) {
					const resolved = result.ref;
					if (resolved && safeBases && !safeBases.some(base => isWithin(base.realPath, resolved.path))) {
						found = null;
						foundToolBases = undefined;
						break;
					}
					found = resolved;
					foundToolBases = safeBases ?? undefined;
					break;
				}
			}
		}
		results.push(found);
		if (found?.kind === "folder") remember(found.path, foundToolBases);
	}
	return results;
}
