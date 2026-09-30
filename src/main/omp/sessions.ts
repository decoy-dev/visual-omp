import { z } from "zod";
import { type FSWatcher, watch } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ProjectSummary, SessionSummary } from "@shared/ipc";
import { userEnv } from "../env";
import { broadcast } from "../ipc";
import { getPrefs } from "../prefs";
import { sessionsDir } from "./paths";

/** Bytes read from the head of each session file: title slot, header and the first user message. */
const HEAD_BYTES = 64 * 1024;

interface CacheEntry {
	mtimeMs: number;
	summary: SessionSummary | null;
}

const cache = new Map<string, CacheEntry>();

const TitleSlot = z.object({ type: z.literal("title"), title: z.string().optional() });
const Header = z.object({
	type: z.literal("session"),
	id: z.string(),
	cwd: z.string(),
	timestamp: z.string().optional(),
	title: z.string().optional(),
	parentSession: z.string().optional(),
});
const UserMessage = z.object({
	type: z.literal("message"),
	message: z.object({
		role: z.literal("user"),
		content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]),
	}),
});

function textOf(content: z.infer<typeof UserMessage>["message"]["content"]): string | null {
	if (typeof content === "string") return content;
	return content.find(part => part.type === "text")?.text ?? null;
}

async function summarize(file: string, mtimeMs: number): Promise<SessionSummary | null> {
	const handle = await open(file, "r");
	let head: string;
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
		head = buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
	let title: string | null = null;
	let header: z.infer<typeof Header> | null = null;
	let preview: string | null = null;
	const lines = head.split("\n");
	// The last line may be cut mid-JSON by the head window; parse only complete lines.
	for (const line of lines.slice(0, -1)) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const slot = TitleSlot.safeParse(entry);
		if (slot.success) {
			title = slot.data.title || title;
			continue;
		}
		const parsedHeader = Header.safeParse(entry);
		if (parsedHeader.success) {
			header = parsedHeader.data;
			continue;
		}
		const user = UserMessage.safeParse(entry);
		if (user.success) {
			preview = textOf(user.data.message.content)?.trim().slice(0, 240) || null;
			if (preview) break;
		}
	}
	if (!header) return null;
	return {
		id: header.id,
		file,
		cwd: header.cwd,
		title: title ?? header.title ?? null,
		createdAt: header.timestamp ? Date.parse(header.timestamp) : mtimeMs,
		updatedAt: mtimeMs,
		parentSession: header.parentSession ?? null,
		preview,
		archived: false,
	};
}

/** Every saved omp session on disk, newest first. Unchanged files come from cache. */
export async function allSessions(): Promise<SessionSummary[]> {
	const root = sessionsDir(await userEnv());
	let buckets: string[];
	try {
		buckets = await readdir(root);
	} catch {
		return [];
	}
	const seen = new Set<string>();
	await Promise.all(
		buckets.map(async bucket => {
			let names: string[];
			try {
				names = await readdir(join(root, bucket));
			} catch {
				return;
			}
			await Promise.all(
				names
					.filter(name => name.endsWith(".jsonl"))
					.map(async name => {
						const file = join(root, bucket, name);
						seen.add(file);
						try {
							const { mtimeMs } = await stat(file);
							const hit = cache.get(file);
							if (hit && hit.mtimeMs === mtimeMs) return;
							cache.set(file, { mtimeMs, summary: await summarize(file, mtimeMs) });
						} catch {
							cache.delete(file);
						}
					}),
			);
		}),
	);
	for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
	const archived = new Set(getPrefs().archivedSessions);
	return [...cache.values()]
		.map(entry => entry.summary)
		.filter((summary): summary is SessionSummary => summary !== null)
		.map(summary => ({ ...summary, archived: archived.has(summary.id) }))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listSessions(cwd: string): Promise<SessionSummary[]> {
	return (await allSessions()).filter(session => session.cwd === cwd);
}

export async function findSessionFile(sessionId: string): Promise<string | null> {
	return (await allSessions()).find(session => session.id === sessionId)?.file ?? null;
}

export async function listProjects(): Promise<ProjectSummary[]> {
	const byCwd = new Map<string, ProjectSummary>();
	for (const session of await allSessions()) {
		const project = byCwd.get(session.cwd);
		if (project) {
			project.sessionCount++;
			project.lastActivity = Math.max(project.lastActivity, session.updatedAt);
		} else {
			byCwd.set(session.cwd, {
				path: session.cwd,
				name: basename(session.cwd) || session.cwd,
				sessionCount: 1,
				lastActivity: session.updatedAt,
				exists: true,
			});
		}
	}
	for (const path of getPrefs().extraProjects) {
		if (!byCwd.has(path)) {
			byCwd.set(path, { path, name: basename(path) || path, sessionCount: 0, lastActivity: 0, exists: true });
		}
	}
	const projects = [...byCwd.values()];
	await Promise.all(
		projects.map(async project => {
			project.exists = await stat(project.path).then(
				s => s.isDirectory(),
				() => false,
			);
		}),
	);
	return projects.sort((a, b) => b.lastActivity - a.lastActivity);
}

export function readSessionFile(file: string): Promise<string> {
	return readFile(file, "utf8");
}

let watcher: FSWatcher | null = null;
let pending: NodeJS.Timeout | undefined;
const changeListeners = new Set<() => void>();

/** Main-process subscribers to session-folder changes (e.g. hosts learning their new session file). */
export function onSessionsChanged(listener: () => void): void {
	changeListeners.add(listener);
}

/**
 * Watch the sessions tree and tell renderers when anything changes. Throttled, so a session omp
 * keeps appending to still refreshes the lists every 400ms instead of never.
 */
export async function watchSessions(): Promise<void> {
	const root = sessionsDir(await userEnv());
	try {
		watcher = watch(root, { recursive: true }, () => {
			if (pending) return;
			pending = setTimeout(() => {
				pending = undefined;
				broadcast("sessions:changed", { cwd: null });
				for (const listener of changeListeners) listener();
			}, 400);
		});
	} catch {
		watcher = null;
	}
}

export function stopWatchingSessions(): void {
	watcher?.close();
	watcher = null;
}
