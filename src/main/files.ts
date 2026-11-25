import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, constants, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { DirEntry } from "@shared/ipc";
import { userEnv } from "./env";
import { resolveExecutable } from "./services/executable";

const IGNORED_DIRS = new Set([".git", "node_modules", ".DS_Store", "dist", "out", ".next", ".turbo", "target", ".venv"]);
const MAX_WALK_FILES = 20_000;

export async function listDir(dir: string): Promise<DirEntry[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter(entry => entry.name !== ".DS_Store")
		.map(entry => ({ name: entry.name, path: join(dir, entry.name), kind: entry.isDirectory() ? ("dir" as const) : ("file" as const) }))
		.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
}

export function readText(file: string): Promise<string> {
	return readFile(file, "utf8");
}

/** Write atomically (unpredictable temp file + O_EXCL + optional mode + rename) so editors and omp never see a half-written file. */
export async function writeText(file: string, content: string, options?: { mode?: number }): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	const mode = options?.mode;
	const handle = await open(tmp, "wx", mode ?? 0o666);
	let closed = false;
	try {
		await handle.writeFile(content, "utf8");
		if (mode !== undefined && process.platform !== "win32") await handle.chmod(mode);
		closed = true;
		await handle.close();
		await rename(tmp, file);
	} catch (error) {
		if (!closed) await handle.close().catch(() => {});
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

export function pathExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

/** A folder a chat can start in: a directory the app can list and enter. */
export async function usableDirectory(path: string): Promise<boolean> {
	try {
		if (!(await stat(path)).isDirectory()) return false;
		await access(path, constants.R_OK | constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Project-relative file list for the @-mention picker: git-tracked + untracked-not-ignored, else a bounded walk. */
export async function projectFiles(cwd: string): Promise<string[]> {
	const env = await userEnv();
	const executable = await resolveExecutable("git", env);
	const { promise, resolve } = Promise.withResolvers<string[] | null>();
	if (executable) execFile(
		executable,
		["ls-files", "--cached", "--others", "--exclude-standard"],
		{ cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 },
		(error, stdout) => resolve(error ? null : stdout.split("\n").filter(Boolean)),
	);
	else resolve(null);
	const tracked = await promise;
	if (tracked) return tracked.slice(0, MAX_WALK_FILES * 5);
	const files: string[] = [];
	async function walk(dir: string): Promise<void> {
		if (files.length >= MAX_WALK_FILES) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= MAX_WALK_FILES) return;
			if (IGNORED_DIRS.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else files.push(relative(cwd, full));
		}
	}
	await walk(cwd);
	return files;
}
