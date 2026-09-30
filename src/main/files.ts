import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { DirEntry } from "@shared/ipc";
import { userEnv } from "./env";

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

/** Write atomically (temp file + rename) so editors and omp never see a half-written file. */
export async function writeText(file: string, content: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, content);
	await rename(tmp, file);
}

export function pathExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

/** Project-relative file list for the @-mention picker: git-tracked + untracked-not-ignored, else a bounded walk. */
export async function projectFiles(cwd: string): Promise<string[]> {
	const env = await userEnv();
	const { promise, resolve } = Promise.withResolvers<string[] | null>();
	execFile(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard"],
		{ cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 },
		(error, stdout) => resolve(error ? null : stdout.split("\n").filter(Boolean)),
	);
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
