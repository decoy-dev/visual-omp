import { z } from "zod";
import { createReadStream, type FSWatcher, watch } from "node:fs";
import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { ProjectSummary, SessionSummary } from "@shared/ipc";
import { userEnv } from "../env";
import { broadcast } from "../ipc";
import { getPrefs } from "../prefs";
import { agentDir, sessionsDir } from "./paths";
import { loadPinnedSessionIds, migrateSessionPins } from "./session-pins";

/** Bytes read from the head of each session file: title slot, header and the first user message. */
const HEAD_BYTES = 64 * 1024;

interface CacheEntry {
	mtimeMs: number;
	summary: SessionSummary | null;
	activity?: Promise<{ id?: string; time: number }>;
	contains?: Map<string, Promise<boolean>>;
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
	continuationOf: z.string().optional(),
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
		continuationOf: header.continuationOf ?? null,
		preview,
		archived: false,
	};
}

/** Every physical session, including copies superseded by a continuation. */
async function physicalSessions(): Promise<SessionSummary[]> {
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
				// omp skips symlinked project buckets so aliases do not list the same sessions twice.
				const directory = join(root, bucket);
				if ((await lstat(directory)).isSymbolicLink()) return;
				names = await readdir(directory);
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
	return [...cache.values()]
		.map(entry => entry.summary)
		.filter((summary): summary is SessionSummary => summary !== null);
}

async function visitEntries(file: string, visit: (entry: Record<string, unknown>) => boolean | void): Promise<void> {
	const stream = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			let entry: Record<string, unknown>;
			try { entry = JSON.parse(line); } catch { continue; }
			if (entry && typeof entry === "object" && visit(entry) === false) break;
		}
	} finally {
		lines.close();
		stream.destroy();
	}
}

/** omp compares conversation activity, excluding exit records and idle eval-state snapshots. */
function activity(session: SessionSummary): Promise<{ id?: string; time: number }> {
	const hit = cache.get(session.file);
	if (hit?.activity) return hit.activity;
	const reading = (async () => {
		let last: { id?: string; time: number } = { time: session.createdAt };
		await visitEntries(session.file, entry => {
			if (!["message", "custom_message", "branch_summary", "reset_boundary"].includes(String(entry.type))) return;
			const message = entry.message as { customType?: unknown } | undefined;
			if ((entry.type === "custom_message" ? entry.customType : message?.customType) === "eval-state-context") return;
			const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
			if (Number.isFinite(time)) last = { time, id: typeof entry.id === "string" ? entry.id : undefined };
		});
		return last;
	})().catch(() => ({ time: Number.NEGATIVE_INFINITY }));
	if (hit) hit.activity = reading;
	return reading;
}

function holdsEntry(file: string, id: string): Promise<boolean> {
	const hit = cache.get(file);
	const cached = hit?.contains?.get(id);
	if (cached) return cached;
	const reading = (async () => {
		let found = false;
		await visitEntries(file, entry => {
			if (entry.type !== "session" && entry.id === id) { found = true; return false; }
		}).catch(() => {});
		return found;
	})();
	if (hit) (hit.contains ??= new Map()).set(id, reading);
	return reading;
}

/**
 * A continuation supersedes its predecessor only while it contains the predecessor's newest turn.
 * A predecessor that kept writing is a separate conversation, matching omp's resume rule.
 */
async function continuationTargets(sessions: SessionSummary[]): Promise<Map<string, SessionSummary>> {
	const byId = new Map(sessions.map(session => [`${dirname(session.file)}\0${session.id}`, session]));
	const children = new Map<string, SessionSummary[]>();
	await Promise.all(sessions.map(async session => {
		const parent = session.continuationOf ? byId.get(`${dirname(session.file)}\0${session.continuationOf}`) : undefined;
		if (!parent || parent.file === session.file) return;
		const latest = await activity(parent);
		if (latest.id && !(await holdsEntry(session.file, latest.id))) return;
		const list = children.get(parent.file) ?? [];
		list.push(session);
		children.set(parent.file, list);
	}));
	const targets = new Map<string, SessionSummary>();
	const resolve = async (session: SessionSummary, seen: Set<string>): Promise<SessionSummary> => {
		if (seen.has(session.file)) return session;
		const cached = targets.get(session.file);
		if (cached) return cached;
		const path = new Set(seen).add(session.file);
		let newest = session;
		let newestTime = (await activity(session)).time;
		for (const child of children.get(session.file) ?? []) {
			if (path.has(child.file)) continue;
			const candidate = await resolve(child, path);
			const time = (await activity(candidate)).time;
			if (time >= newestTime) { newest = candidate; newestTime = time; }
		}
		targets.set(session.file, newest);
		return newest;
	};
	for (const session of sessions) {
		if (children.has(session.file)) await resolve(session, new Set());
		else targets.set(session.file, session);
	}
	return targets;
}

/** Saved conversations, newest first, with superseded copies folded into their latest file. */
export async function allSessions(): Promise<SessionSummary[]> {
	const physical = await physicalSessions();
	const targets = await continuationTargets(physical);
	const archived = new Set(getPrefs().archivedSessions);
	const previousByFile = new Map<string, SessionSummary[]>();
	for (const copy of physical) {
		const target = targets.get(copy.file);
		if (!target || target.file === copy.file) continue;
		const previous = previousByFile.get(target.file) ?? [];
		previous.push(copy);
		previousByFile.set(target.file, previous);
	}
	const conversations = physical.filter(session => targets.get(session.file)?.file === session.file).map(session => {
		const previous = previousByFile.get(session.file) ?? [];
		return {
			...session,
			previousSessionFiles: previous.map(copy => copy.file),
			previousSessionIds: previous.map(copy => copy.id),
			archived: archived.has(session.id) || previous.some(copy => archived.has(copy.id)),
		};
	}).sort((a, b) => b.updatedAt - a.updatedAt);
	await migrateSessionPins(conversations).catch(error => console.warn("Could not migrate saved chat pins", error));
	const pinned = await loadPinnedSessionIds();
	return conversations.map(session => ({
		...session,
		pinned: pinned.has(session.id) || session.previousSessionIds.some(id => pinned.has(id)),
	}));
}

/** Resolve an old saved copy before history, navigation or export reads it. */
export async function resolveSessionFile(file: string): Promise<string> {
	const sessions = await physicalSessions();
	return (await continuationTargets(sessions)).get(file)?.file ?? file;
}

export async function sessionSummary(file: string): Promise<SessionSummary | null> {
	return (await allSessions()).find(session => session.file === file || session.previousSessionFiles?.includes(file)) ?? null;
}

export async function listSessions(cwd: string): Promise<SessionSummary[]> {
	return (await allSessions()).filter(session => session.cwd === cwd);
}

export async function recentSessions(limit: number): Promise<SessionSummary[]> {
	return (await allSessions()).filter(session => !session.archived).slice(0, Math.max(0, limit));
}

export async function findSessionFile(sessionId: string): Promise<string | null> {
	// A live room reports an exact session id. Never substitute a different process's continuation.
	return (await physicalSessions()).find(session => session.id === sessionId)?.file ?? null;
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
let pinsWatcher: FSWatcher | null = null;
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
	try {
		pinsWatcher = watch(agentDir(await userEnv()), (_event, name) => {
			if (name?.toString() === "session-pins.json") broadcast("sessions:changed", { cwd: null });
		});
	} catch {
		pinsWatcher = null;
	}
}

export function stopWatchingSessions(): void {
	watcher?.close();
	watcher = null;
	pinsWatcher?.close();
	pinsWatcher = null;
}
