import { createHash } from "node:crypto";
import { type FSWatcher, unwatchFile, watch, watchFile } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BtwTopic, BtwTurn } from "@shared/contracts/btw";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const timestamp = z.number().min(0).max(8640000000000000);
const turnFields = {
	question: z.string(),
	images: z.array(z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).strict()).optional(),
	answer: z.string(),
	status: z.enum(["running", "complete", "cancelled", "error", "interrupted"]),
	createdAt: timestamp,
	updatedAt: timestamp,
	error: z.string().optional(),
};
// Mirrors omp 18.15.0 session/btw-history.ts. Titles exist only in a text sidecar.
const turnSchema = z.object(turnFields).strict();
const recordSchema = z.object({
	...turnFields,
	id: z.string().regex(ID),
	leafId: z.string().nullable(),
	followUps: z.array(turnSchema).optional(),
}).strict();

type StoredTurn = z.infer<typeof turnSchema>;

export interface BtwHistoryLogger {
	warn(message: string, details: { path: string; error: string }): void;
}

export interface BtwHistoryOptions {
	/** Parent artifacts directory when a focused session adopts its parent's storage. */
	artifactsDir?: string;
	/** Owning focused session id. Absent means the main session's history. */
	scope?: string;
	/** Include every focused history as well as the main history. Ignored with an explicit scope. */
	includeScopes?: boolean;
	/** Resume-time projection only. Disk records are never changed. Defaults to false. */
	recoverRunning?: boolean;
	/** Caller-established live overlay matches; only these topics retain running on recovery. */
	liveTopicIds?: ReadonlySet<string>;
	logger?: BtwHistoryLogger;
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function warn(options: BtwHistoryOptions, message: string, path: string, error: unknown): void {
	(options.logger ?? console).warn(message, { path, error: error instanceof Error ? error.message : String(error) });
}

/** omp SessionManager.getArtifactsDir(), including its lazy, absent-directory case. */
export function btwArtifactsDir(sessionFile: string): string | null {
	return sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : null;
}

function scopeSegment(scope: string): string {
	return /^[\w-]+$/.test(scope) ? scope : createHash("sha256").update(scope).digest("hex");
}

export function btwHistoryDirectory(sessionFile: string, options: BtwHistoryOptions = {}): string | null {
	const artifacts = options.artifactsDir ?? btwArtifactsDir(sessionFile);
	if (artifacts === null) return null;
	const root = join(artifacts, "btw-history");
	return options.scope === undefined ? root : join(root, "sessions", scopeSegment(options.scope));
}

async function namesIn(directory: string, options: BtwHistoryOptions): Promise<string[]> {
	try {
		if (!(await lstat(directory)).isDirectory()) throw new Error("Expected a directory");
		return await readdir(directory);
	} catch (error) {
		if (!missing(error)) warn(options, "Ignoring unreadable BTW history directory", directory, error);
		return [];
	}
}

/** Directory segments identify scopes discovered without an owning session header. */
export async function listBtwHistoryScopes(sessionFile: string, options: BtwHistoryOptions = {}): Promise<string[]> {
	const root = btwHistoryDirectory(sessionFile, { ...options, scope: undefined });
	if (!root) return [];
	const directory = join(root, "sessions");
	const scopes: string[] = [];
	for (const name of (await namesIn(directory, options)).sort()) {
		if (!/^[\w-]+$/.test(name)) continue;
		try {
			if ((await lstat(join(directory, name))).isDirectory()) scopes.push(name);
		} catch (error) {
			if (!missing(error)) warn(options, "Ignoring unreadable BTW history scope", join(directory, name), error);
		}
	}
	return scopes;
}

async function regularText(path: string): Promise<string> {
	if (!(await lstat(path)).isFile()) throw new Error("Expected a regular file");
	return readFile(path, "utf8");
}

function projectTurn(turn: StoredTurn, recover: boolean): BtwTurn {
	return {
		question: turn.question,
		answer: turn.answer,
		status: recover && turn.status === "running" ? "interrupted" : turn.status,
		createdAt: turn.createdAt,
		updatedAt: turn.updatedAt,
		...(turn.error === undefined ? {} : { error: turn.error }),
	};
}

async function readTopic(directory: string, id: string, options: BtwHistoryOptions): Promise<BtwTopic | null> {
	const path = join(directory, `entry-${id}.json`);
	try {
		const record = recordSchema.parse(JSON.parse(await regularText(path)));
		if (record.id !== id) throw new Error("Record id does not match its filename");
		let title = record.question;
		const titlePath = join(directory, `entry-${id}.title`);
		try {
			title = await regularText(titlePath);
		} catch (error) {
			if (!missing(error)) warn(options, "Ignoring unreadable BTW history title", titlePath, error);
		}
		const live = options.liveTopicIds?.has(id) ?? false;
		const recover = options.recoverRunning === true && !live;
		return {
			id,
			title,
			turns: [record, ...(record.followUps ?? [])].map(turn => projectTurn(turn, recover)),
			live,
			...(options.scope === undefined ? {} : { scope: options.scope }),
		};
	} catch (error) {
		if (!missing(error)) warn(options, "Ignoring malformed BTW history record", path, error);
		return null;
	}
}

/** Read one topic from the explicitly selected scope. Invalid ids never become paths. */
export async function readBtwTopic(sessionFile: string, id: string, options: BtwHistoryOptions = {}): Promise<BtwTopic | null> {
	if (!ID.test(id)) return null;
	const directory = btwHistoryDirectory(sessionFile, options);
	return directory === null ? null : readTopic(directory, id, options);
}

/** Read topics newest first, with the same timestamp/id ordering as omp's store. */
export async function listBtwHistory(sessionFile: string, options: BtwHistoryOptions = {}): Promise<BtwTopic[]> {
	const directory = btwHistoryDirectory(sessionFile, options);
	if (directory === null) return [];
	const topics: BtwTopic[] = [];
	for (const name of (await namesIn(directory, options)).sort()) {
		if (!name.startsWith("entry-") || !name.endsWith(".json")) continue;
		const id = name.slice("entry-".length, -".json".length);
		if (!ID.test(id)) {
			warn(options, "Ignoring malformed BTW history record", join(directory, name), new Error("Invalid BTW history record id"));
			continue;
		}
		const topic = await readTopic(directory, id, options);
		if (topic) topics.push(topic);
	}
	if (options.includeScopes && options.scope === undefined) {
		for (const scope of await listBtwHistoryScopes(sessionFile, options)) {
			topics.push(...await listBtwHistory(sessionFile, { ...options, scope, includeScopes: false }));
		}
	}
	return topics.sort((a, b) => b.turns[0]!.createdAt - a.turns[0]!.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || ((a.scope ?? "") < (b.scope ?? "") ? -1 : (a.scope ?? "") > (b.scope ?? "") ? 1 : 0));
}

export interface BtwHistoryWatcher {
	/** Reread using the options object, including caller-updated live matches and recovery policy. */
	refresh(): Promise<BtwTopic[]>;
	close(): void;
}

/**
 * Watch sidecars without materializing their directories. fs.watch handles in-place content
 * changes; stat polling notices missing directories, recreation and replacement inodes.
 * The returned watcher owns every timer/listener and suppresses late delivery after close.
 */
export function watchBtwHistory(
	sessionFile: string,
	onChange: (topics: BtwTopic[]) => void,
	options: BtwHistoryOptions = {},
): BtwHistoryWatcher {
	const watched = new Map<string, { watcher: FSWatcher | null; changed: () => void }>();
	let closed = false;
	let timer: NodeJS.Timeout | undefined;
	let pending: Promise<BtwTopic[]> = Promise.resolve([]);
	let published: string | undefined;

	const schedule = (): void => {
		if (closed || timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			void refresh();
		}, 120);
		timer.unref();
	};
	const attach = (path: string): void => {
		const entry = watched.get(path);
		if (!entry || closed) return;
		entry.watcher?.close();
		entry.watcher = null;
		try {
			entry.watcher = watch(path, { persistent: false }, schedule);
			entry.watcher.on("error", () => {
				entry.watcher?.close();
				entry.watcher = null;
				schedule();
			});
		} catch {
			// Stat polling below remains registered while this directory is absent.
		}
	};
	const reconcile = async (): Promise<void> => {
		const directory = btwHistoryDirectory(sessionFile, options);
		const wanted = new Set<string>(directory === null ? [] : [directory]);
		if (directory && options.includeScopes && options.scope === undefined) {
			wanted.add(join(directory, "sessions"));
			for (const scope of await listBtwHistoryScopes(sessionFile, options)) wanted.add(join(directory, "sessions", scope));
		}
		if (closed) return;
		for (const [path, entry] of watched) {
			if (wanted.has(path)) continue;
			entry.watcher?.close();
			unwatchFile(path, entry.changed);
			watched.delete(path);
		}
		for (const path of wanted) {
			if (watched.has(path)) continue;
			const changed = (): void => { attach(path); schedule(); };
			watched.set(path, { watcher: null, changed });
			watchFile(path, { persistent: false, interval: 500 }, changed);
			attach(path);
		}
	};
	const refresh = (): Promise<BtwTopic[]> => {
		pending = pending.then(async previous => {
			if (closed) return previous;
			await reconcile();
			const topics = await listBtwHistory(sessionFile, options);
			if (closed) return previous;
			const signature = JSON.stringify(topics);
			if (signature !== published) {
				published = signature;
				onChange(topics);
			}
			return topics;
		}).catch(error => {
			if (!closed) warn(options, "Could not refresh BTW history", sessionFile, error);
			return [];
		});
		return pending;
	};
	void refresh();
	return {
		refresh,
		close(): void {
			closed = true;
			clearTimeout(timer);
			for (const [path, entry] of watched) {
				entry.watcher?.close();
				unwatchFile(path, entry.changed);
			}
			watched.clear();
		},
	};
}
