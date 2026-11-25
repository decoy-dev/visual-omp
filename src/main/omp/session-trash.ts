import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { shell } from "electron";
import { userEnv } from "../env";
import { sessionsDir } from "./paths";
import { sessionSummary } from "./sessions";
import { listHosts, stopHost } from "./host";
import { sessionOwnership } from "./elsewhere";

function normalizeForCompare(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinOrEqual(candidate: string, root: string): boolean {
	const rel = relative(normalizeForCompare(root), normalizeForCompare(candidate));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function nearestRealPath(target: string): Promise<string | null> {
	let current = resolve(target);
	for (;;) {
		try {
			return await realpath(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
			const parent = dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}
}

async function assertNotSymlink(target: string): Promise<void> {
	try {
		if ((await lstat(target)).isSymbolicLink()) {
			throw new Error("This is not an omp session file.");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

async function assertTrashableSessionFile(
	candidate: string,
	rootRaw: string,
	rootReal: string,
	liveHostFiles: ReadonlySet<string>,
): Promise<void> {
	if (!candidate || candidate.includes("\0") || !isAbsolute(candidate) || !candidate.endsWith(".jsonl")) {
		throw new Error("This is not an omp session file.");
	}
	const resolved = resolve(candidate);
	const artifactDir = resolved.slice(0, -".jsonl".length);
	await assertNotSymlink(resolved);
	await assertNotSymlink(artifactDir);
	if (liveHostFiles.has(normalizeForCompare(resolved))) return;

	if (!isWithinOrEqual(resolved, rootRaw) && !isWithinOrEqual(resolved, rootReal)) {
		throw new Error("This is not an omp session file.");
	}
	const parent = dirname(resolved);
	const parentReal = await nearestRealPath(parent);
	if (!parentReal || !isWithinOrEqual(parentReal, rootReal)) {
		throw new Error("This is not an omp session file.");
	}
}

/** Keep every original path intact in the system Trash so the operating system can put it back. */
export async function trashSessionConversation(file: string): Promise<void> {
	if (!file.endsWith(".jsonl")) throw new Error("This is not an omp session file.");
	const rootRaw = resolve(sessionsDir(await userEnv()));
	const rootReal = await realpath(rootRaw).catch(() => rootRaw);
	const liveHosts = listHosts();
	const liveHostFiles = new Set(
		liveHosts
			.filter(host => host.phase !== "exited" && host.sessionFile)
			.map(host => normalizeForCompare(host.sessionFile!)),
	);
	await assertTrashableSessionFile(file, rootRaw, rootReal, liveHostFiles);
	const session = await sessionSummary(file);
	const files = session ? [session.file, ...(session.previousSessionFiles ?? [])] : [file];
	for (const entry of files) {
		await assertTrashableSessionFile(entry, rootRaw, rootReal, liveHostFiles);
	}
	for (const host of liveHosts) {
		if (host.phase !== "exited" && host.sessionFile && files.includes(host.sessionFile)) await stopHost(host.hostId);
	}
	const owners = await sessionOwnership(files);
	const blocked = files.filter(source => owners.get(source) !== "free");
	if (blocked.length) throw new Error(`This chat still has running or unverified omp owners. No files were moved to the system Trash:\n${blocked.join("\n")}`);
	const failures: string[] = [];
	for (const source of files) {
		for (const target of [source, source.slice(0, -".jsonl".length)]) {
			try {
				const info = await lstat(target);
				if (info.isSymbolicLink()) throw new Error("Refusing to trash a symbolic link.");
				await shell.trashItem(target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				failures.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	if (failures.length) throw new Error(`Some chat files could not be moved to the system Trash. These paths remain:\n${failures.join("\n")}`);
}
