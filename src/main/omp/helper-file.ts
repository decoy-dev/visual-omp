import { type FileHandle, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const helperRoots = new Map<string, string>();

/** Reject symlinks at the helper root and every component below it, including after an atomic replacement. */
async function assertHelperPath(root: string, file: string): Promise<void> {
	const within = relative(root, file);
	if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("The helper transcript is outside this chat's helper directory.");
	if (relative(root, await realpath(root)) || (await lstat(root)).isSymbolicLink()) throw new Error("The helper directory changed to a symbolic link.");
	let current = root;
	for (const component of within.split(sep)) {
		current = join(current, component);
		if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links are not allowed in a helper transcript path.");
	}
	if (relative(file, await realpath(file))) throw new Error("The helper transcript path changed.");
}

/** A registered helper's tail validates its path and the opened file identity before reading any bytes. */
export function helperFileValidation(file: string): ((handle: FileHandle) => Promise<void>) | undefined {
	const root = helperRoots.get(file);
	if (!root) return undefined;
	return async handle => {
		await assertHelperPath(root, file);
		const [opened, current] = await Promise.all([handle.stat(), stat(file)]);
		if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error("The helper transcript changed while it was being opened.");
	};
}

/** omp stores each helper as <parent stem>/<qualified id>.jsonl, nesting child folders by qualified id. */
export async function helperSessionFile(parent: string, id: string): Promise<string | null> {
	if (!parent.endsWith(".jsonl") || !id || /[/\\\0]/.test(id) || id.split(".").some(part => !part || part === "..")) return null;
	let root = resolve(parent.slice(0, -6));
	if ((await lstat(root).catch(() => null))?.isSymbolicLink()) return null;
	const canonicalRoot = await realpath(root).catch(() => null);
	if (!canonicalRoot) return null;
	root = canonicalRoot;
	const parts = id.split(".");
	for (let depth = 0; depth < parts.length; depth++) {
		const file = join(root, `${id}.jsonl`);
		try {
			await assertHelperPath(canonicalRoot, file);
			const canonicalFile = await realpath(file);
			if ((await stat(canonicalFile)).isFile()) { helperRoots.set(canonicalFile, canonicalRoot); return canonicalFile; }
		} catch { /* Missing and unsafe candidates remain unavailable. */ }
		root = join(root, parts.slice(0, depth + 1).join("."));
	}
	return null;
}
