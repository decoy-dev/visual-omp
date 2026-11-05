import { randomUUID } from "node:crypto";
import { type FSWatcher, watch as fsWatch } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { WebContents } from "electron";
import type { PreviewChange, PreviewSequencePattern, PreviewWatchRequest } from "@shared/contracts/preview";
import { runGit } from "../git/run";
import { broadcast, handleWithEvent } from "../ipc";
import { broadFolders, isBroadFolder } from "./panes";

const VISUAL_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|pdf|html?|mp4|m4v|webm|mov|docx|xlsx|pptx)$/i;
const DEBOUNCE_MS = 250;
const STABLE_MS = 150;
const IDLE_MS = 4 * 60 * 60 * 1000;
const MAX_DIRS = 2000;

interface Root {
	path: string;
	recursive: boolean;
}
interface Subscription {
	watcher: FSWatcher;
	users: Set<Watch>;
}
interface Sequence {
	key: string;
	folder: string;
	pattern: PreviewSequencePattern;
}
interface Watch {
	id: string;
	folder: string;
	/**
	 * Canonical path to the spelling the renderer used (the chat folder and named paths), so events match the paths
	 * omp's calls name. On macOS `/tmp` is a link to `/private/tmp`, and a realpath would not match `/tmp/...`.
	 */
	spellings: Map<string, string>;
	namedFiles: Set<string>;
	namedFolders: Set<string>;
	missingNamed: Set<string>;
	sequences: Sequence[];
	missingSequences: Set<string>;
	sequenceSeen: Map<string, { path: string; size: number; mtimeMs: number; count: number }>;
	roots: Root[];
	subscriptions: Set<string>;
	pending: Set<string>;
	readVersions: Map<string, number>;
	seen: Map<string, { size: number; mtimeMs: number }>;
	timer?: NodeJS.Timeout;
	idle?: NodeJS.Timeout;
	reading?: Promise<void>;
	updating: Promise<void>;
	ending: boolean;
	closed: boolean;
}

export interface PreviewWatchOptions {
	/** Linux walks subscriptions explicitly; other platforms use native recursive watching. */
	platform?: NodeJS.Platform;
	watch?: (path: string, options: { recursive: boolean; persistent: boolean }, listener: (event: string, filename: string | null) => void) => FSWatcher;
	maxDirectories?: number;
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function excluded(path: string): boolean {
	return path.split(sep).some(part => part === ".git" || part === "node_modules" || part === "partial_movie_files");
}
function rootKey(root: Root): string {
	return `${root.recursive ? "r" : "f"}:${root.path}`;
}
async function canonical(path: string): Promise<string> {
	const absolute = resolve(path);
	const suffix: string[] = [];
	let ancestor = absolute;
	while (true) {
		const real = await realpath(ancestor).catch(() => null);
		if (real) return join(real, ...suffix.reverse());
		const parent = dirname(ancestor);
		if (parent === ancestor) return absolute;
		suffix.push(basename(ancestor));
		ancestor = parent;
	}
}

function matches(sequence: Sequence, path: string): boolean {
	if (dirname(path) !== sequence.folder) return false;
	const name = basename(path);
	const { prefix, digits, suffix } = sequence.pattern;
	if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
	const number = name.slice(prefix.length, name.length - suffix.length);
	return /^\d+$/.test(number) && (digits === null || number.length === digits);
}

/** Modification time chooses the latest save; numeric order breaks equal timestamps for frame batches. */
function newer(left: { path: string; mtimeMs: number }, right: { path: string; mtimeMs: number }): boolean {
	if (left.mtimeMs !== right.mtimeMs) return left.mtimeMs > right.mtimeMs;
	return basename(left.path).localeCompare(basename(right.path), "en", { numeric: true }) > 0;
}

async function existingParent(path: string): Promise<string> {
	let parent = dirname(path);
	while (true) {
		if ((await lstat(parent).catch(() => null))?.isDirectory()) return parent;
		const next = dirname(parent);
		if (next === parent) return parent;
		parent = next;
	}
}

/** Uses the git watcher's check-ignore invocation, including its literal-pathspec override. */
async function ignoredPaths(folder: string, paths: string[]): Promise<Set<string>> {
	if (paths.length === 0) return new Set();
	const result = await runGit(["--no-literal-pathspecs", "check-ignore", "--no-index", "-z", "--stdin"], {
		cwd: folder,
		input: `${paths.join("\0")}\0`,
		timeoutMs: 5000,
	}).catch(() => null);
	return new Set(result?.code === 0 ? result.stdout.split("\0").filter(Boolean) : []);
}

/** Turn-scoped watches share operating-system subscriptions but keep their event attribution separate. */
export class PreviewWatchService {
	private readonly watches = new Map<string, Watch>();
	private readonly subscriptions = new Map<string, Subscription>();
	private readonly platform: NodeJS.Platform;
	private readonly fsWatch: NonNullable<PreviewWatchOptions["watch"]>;
	private readonly maxDirectories: number;

	constructor(private readonly emit: (change: PreviewChange) => void, options: PreviewWatchOptions = {}) {
		this.platform = options.platform ?? process.platform;
		this.fsWatch = options.watch ?? fsWatch;
		this.maxDirectories = options.maxDirectories ?? MAX_DIRS;
	}

	async watch(request: PreviewWatchRequest): Promise<string> {
		if (!request || typeof request.folder !== "string" || !isAbsolute(request.folder)) throw new Error("Invalid preview folder");
		const folder = await canonical(request.folder);
		const state: Watch = {
			id: randomUUID(), folder, spellings: new Map([[folder, resolve(request.folder)]]), namedFiles: new Set(), namedFolders: new Set(), missingNamed: new Set(), roots: [], subscriptions: new Set(),
			sequences: [], missingSequences: new Set(), sequenceSeen: new Map(),
			pending: new Set(), readVersions: new Map(), seen: new Map(), updating: Promise.resolve(), ending: false, closed: false,
		};
		this.watches.set(state.id, state);
		try {
			await this.watchNamed(state.id, request.named, request.sequences);
			return state.id;
		} catch (error) {
			this.close(state.id);
			throw error;
		}
	}

	async watchNamed(id: string, named: string[], sequences: PreviewSequencePattern[]): Promise<void> {
		const state = this.watches.get(id);
		if (!state || state.ending) return;
		if (!Array.isArray(named) || named.some(path => typeof path !== "string" || !isAbsolute(path))) throw new Error("Invalid preview paths");
		if (!Array.isArray(sequences) || sequences.some(pattern => !pattern || typeof pattern.folder !== "string" || !isAbsolute(pattern.folder)
			|| typeof pattern.prefix !== "string" || typeof pattern.suffix !== "string"
			|| [pattern.prefix, pattern.suffix].some(part => part.includes("\0") || basename(part) !== part)
			|| (pattern.digits !== null && (!Number.isSafeInteger(pattern.digits) || pattern.digits < 1)))) throw new Error("Invalid preview sequences");
		this.touch(state);
		const update = state.updating.then(async () => {
			if (state.closed || state.ending) return;
			const extra = await broadFolders();
			const files = new Set<string>();
			const folders = new Set<string>();
			const missing = new Set<string>();
			const spellings = new Map([[state.folder, state.spellings.get(state.folder)!]]);
			const patterns: Sequence[] = [];
			const missingSequences = new Set<string>();
			for (const pattern of sequences) {
				const folder = await canonical(pattern.folder);
				if (excluded(folder)) continue;
				const info = await lstat(folder).catch(() => null);
				if (info && !info.isDirectory()) continue;
				const key = JSON.stringify([folder, pattern.folder, pattern.prefix, pattern.digits, pattern.suffix]);
				if (patterns.some(sequence => sequence.key === key)) continue;
				patterns.push({ key, folder, pattern: { ...pattern } });
				spellings.set(folder, resolve(pattern.folder));
				if (!info) missingSequences.add(folder);
			}
			for (const raw of named) {
				const path = await canonical(raw);
				spellings.set(path, resolve(raw));
				if (excluded(path)) continue;
				const info = await lstat(path).catch(() => null);
				if (info?.isDirectory()) {
					if (!isBroadFolder(path, extra)) folders.add(path);
				} else if (!info || info.isFile()) {
					files.add(path);
					if (!info) missing.add(path);
				}
			}
			const addedFolders = [...folders].filter(path => !state.namedFolders.has(path));
			const retiring = [...state.namedFiles].some(path => !files.has(path)) || [...state.namedFolders].some(path => !folders.has(path))
				|| state.sequences.some(sequence => !patterns.some(pattern => pattern.key === sequence.key));
			if (retiring) {
				// Overlap both scopes, retaining outgoing spellings until its last stable read finishes.
				state.namedFiles = new Set([...state.namedFiles, ...files]);
				state.namedFolders = new Set([...state.namedFolders, ...folders]);
				state.missingNamed = new Set([...state.missingNamed, ...missing]);
				state.sequences = [...state.sequences, ...patterns.filter(pattern => !state.sequences.some(sequence => sequence.key === pattern.key))];
				state.missingSequences = new Set([...state.missingSequences, ...missingSequences]);
				state.spellings = new Map([...spellings, ...state.spellings]);
				await this.updateRoots(state, extra);
				await this.subscribe(state);
				await this.scanFolders(state, addedFolders);
				clearTimeout(state.timer);
				for (const path of state.namedFiles) this.queue(state, path);
				await this.scanSequences(state);
				await delay(DEBOUNCE_MS);
				await state.reading;
				clearTimeout(state.timer);
				if (state.closed) return;
				state.reading = this.read(state, true);
				await state.reading;
				state.reading = undefined;
			}
			if (state.closed || state.ending) return;
			state.namedFiles = files;
			state.spellings = spellings;
			state.namedFolders = folders;
			state.missingNamed = missing;
			state.sequences = patterns;
			state.missingSequences = missingSequences;
			await this.updateRoots(state, extra);
			await this.subscribe(state);
			if (missing.size || missingSequences.size) await this.refreshMissing(state);
			else for (const path of files) this.queue(state, path);
			if (!retiring) await this.scanFolders(state, addedFolders);
			await this.scanSequences(state);
		});
		state.updating = update.catch(() => {});
		await update;
	}

	async unwatch(id: string): Promise<void> {
		const state = this.watches.get(id);
		if (!state || state.ending) return;
		state.ending = true;
		clearTimeout(state.timer);
		clearTimeout(state.idle);
		await state.updating;
		await state.reading;
		if (state.closed) return;
		for (const path of state.namedFiles) if (VISUAL_EXT.test(path)) state.pending.add(path);
		await this.scanSequences(state);
		await delay(DEBOUNCE_MS);
		await this.read(state, true);
		this.close(id);
	}

	/** Reload and renderer loss close immediately, without publishing another frame to a new renderer. */
	close(id: string): void {
		const state = this.watches.get(id);
		if (!state) return;
		state.closed = true;
		clearTimeout(state.timer);
		clearTimeout(state.idle);
		for (const key of state.subscriptions) this.release(state, key);
		this.watches.delete(id);
	}

	private async updateRoots(state: Watch, extra: ReadonlySet<string>): Promise<void> {
		state.roots = [
			...(!isBroadFolder(state.folder, extra) ? [{ path: state.folder, recursive: true }] : []),
			...[...state.namedFolders].map(path => ({ path, recursive: true })),
			...await Promise.all([...state.namedFiles].map(async path => ({ path: await existingParent(path), recursive: false }))),
			...await Promise.all(state.sequences.map(async sequence => ({
				path: (await lstat(sequence.folder).catch(() => null))?.isDirectory() ? sequence.folder : await existingParent(sequence.folder),
				recursive: false,
			}))),
		];
	}

	private async refreshMissing(state: Watch): Promise<void> {
		if (state.closed || state.ending) return;
		const promoted: string[] = [];
		if (state.missingNamed.size) {
			const extra = await broadFolders();
			// Install the closest ancestor subscription before checking for creation, so moving the watch leaves no blind spot.
			await this.updateRoots(state, extra);
			await this.subscribe(state);
			if (state.closed || state.ending) return;
			for (const path of state.missingNamed) {
				const info = await lstat(path).catch(() => null);
				if (!info) continue;
				state.missingNamed.delete(path);
				if (info.isDirectory()) {
					state.namedFiles.delete(path);
					if (!isBroadFolder(path, extra)) {
						state.namedFolders.add(path);
						promoted.push(path);
					}
				} else if (!info.isFile()) state.namedFiles.delete(path);
			}
			await this.updateRoots(state, extra);
		}
		await this.subscribe(state);
		if (state.missingSequences.size) {
			for (const folder of state.missingSequences) if ((await lstat(folder).catch(() => null))?.isDirectory()) state.missingSequences.delete(folder);
			await this.updateRoots(state, await broadFolders());
			await this.subscribe(state);
		}
		for (const path of state.namedFiles) this.queue(state, path);
		await this.scanFolders(state, promoted);
		await this.scanSequences(state);
	}

	/** Frame scopes are direct-child subscriptions, including when the chat folder itself is broad. */
	private async scanSequences(state: Watch): Promise<void> {
		for (const sequence of state.sequences) {
			if (!(await lstat(sequence.folder).catch(() => null))?.isDirectory()) continue;
			const entries = await readdir(sequence.folder, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				const path = join(sequence.folder, entry.name);
				if (entry.isFile() && matches(sequence, path)) this.queue(state, path);
			}
		}
	}

	/** Catch saves made before a newly named folder's subscription was installed. */
	private async scanFolders(state: Watch, folders: string[]): Promise<void> {
		// Linux rescans newly subscribed folders in subscribe, including their descendants.
		if (this.platform === "linux") return;
		const pending = [...folders];
		let visited = 0;
		while (pending.length && visited++ < this.maxDirectories) {
			if (state.closed || state.ending) return;
			const folder = pending.pop()!;
			const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				const path = join(folder, entry.name);
				if (excluded(path)) continue;
				if (entry.isFile()) this.queue(state, path);
				else if (entry.isDirectory()) pending.push(path);
			}
		}
	}

	private touch(state: Watch): void {
		clearTimeout(state.idle);
		state.idle = setTimeout(() => this.close(state.id), IDLE_MS);
		state.idle.unref();
	}

	private named(state: Watch, path: string): boolean {
		if (state.namedFiles.has(path)) return true;
		for (const folder of state.namedFolders) if (inside(folder, path)) return true;
		if (state.sequences.some(sequence => matches(sequence, path))) return true;
		return false;
	}

	/** The renderer's spelling of `path`: the longest canonical prefix it named, with the rest appended. */
	private spelled(state: Watch, path: string): string {
		let best: [string, string] | null = null;
		for (const entry of state.spellings) {
			if ((path === entry[0] || inside(entry[0], path)) && (!best || entry[0].length > best[0].length)) best = entry;
		}
		return best ? join(best[1], relative(best[0], path)) : path;
	}

	private allowed(state: Watch, path: string): boolean {
		return !excluded(path) && (this.named(state, path) || state.roots.some(root => root.recursive && inside(root.path, path)));
	}

	private queue(state: Watch, path: string): void {
		if (state.closed || !VISUAL_EXT.test(path) || !this.allowed(state, path)) return;
		state.pending.add(path);
		state.readVersions.set(path, (state.readVersions.get(path) ?? 0) + 1);
		if (state.ending) return;
		clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			state.timer = undefined;
			void this.flush(state);
		}, DEBOUNCE_MS);
	}

	private async flush(state: Watch): Promise<void> {
		await state.reading;
		if (state.closed || state.ending) return;
		state.reading = this.read(state, false);
		await state.reading;
		state.reading = undefined;
	}

	private async read(state: Watch, final: boolean): Promise<void> {
		const pending = [...state.pending];
		const paths = new Set(pending);
		const sequences = state.sequences.filter(sequence => pending.some(path => matches(sequence, path)));
		const versions = new Map(pending.map(path => [path, state.readVersions.get(path)]));
		state.pending.clear();
		// Include previously seen frames so the count and latest frame describe the folder's current contents.
		for (const sequence of sequences) {
			if (!(await lstat(sequence.folder).catch(() => null))?.isDirectory()) {
				for (const path of paths) if (matches(sequence, path)) paths.delete(path);
				continue;
			}
			const entries = await readdir(sequence.folder, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				const path = join(sequence.folder, entry.name);
				if (entry.isFile() && matches(sequence, path) && VISUAL_EXT.test(path)) {
					paths.add(path);
					if (!versions.has(path)) versions.set(path, state.readVersions.get(path));
				}
			}
		}
		const ignored = await ignoredPaths(state.folder, [...paths].filter(path => !this.named(state, path)));
		const candidates = [...paths].filter(path => !ignored.has(path) && this.allowed(state, path));
		const first = await Promise.all(candidates.map(path => lstat(path).catch(() => null)));
		if (candidates.length) await delay(STABLE_MS);
		const groups = new Map<Sequence, { count: number; latest?: { path: string; size: number; mtimeMs: number } }>(sequences.map(sequence => [sequence, { count: 0 }]));
		for (const [index, path] of candidates.entries()) {
			if (state.closed) return;
			const before = first[index];
			const after = await lstat(path).catch(() => null);
			const matchingGroups = sequences.filter(sequence => matches(sequence, path)).map(sequence => groups.get(sequence)!);
			if (after?.isFile()) for (const group of matchingGroups) group.count++;
			if (!before?.isFile() || !after?.isFile()) continue;
			if (!final && state.readVersions.get(path) !== versions.get(path)) {
				this.queue(state, path);
				continue;
			}
			if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
				if (!final) this.queue(state, path);
				continue;
			}
			const stamp = { size: after.size, mtimeMs: after.mtimeMs };
			if (matchingGroups.length) {
				const frame = { path, ...stamp };
				for (const group of matchingGroups) if (!group.latest || newer(frame, group.latest)) group.latest = frame;
				state.seen.set(path, stamp);
				continue;
			}
			const previous = state.seen.get(path);
			if (previous?.size === after.size && previous.mtimeMs === after.mtimeMs) continue;
			state.seen.set(path, stamp);
			this.emit({ watchId: state.id, path: this.spelled(state, path), ...stamp });
		}
		for (const [sequence, { count, latest }] of groups) {
			if (state.closed) return;
			if (!latest) continue;
			const previous = state.sequenceSeen.get(sequence.key);
			if (previous?.path === latest.path && previous.size === latest.size && previous.mtimeMs === latest.mtimeMs && previous.count === count) continue;
			state.sequenceSeen.set(sequence.key, { ...latest, count });
			this.emit({ watchId: state.id, ...latest, path: this.spelled(state, latest.path), sequence: { pattern: sequence.pattern, count } });
		}
	}

	private release(state: Watch, key: string): void {
		const subscription = this.subscriptions.get(key);
		subscription?.users.delete(state);
		if (subscription?.users.size === 0) {
			subscription.watcher.close();
			this.subscriptions.delete(key);
		}
		state.subscriptions.delete(key);
	}

	private async linuxRoots(state: Watch, roots: Root[]): Promise<Root[] | null> {
		const kept = new Set<string>();
		const traversed = new Set<string>();
		const pending = roots.filter(root => root.recursive).map(root => root.path);
		for (const root of roots) if (!root.recursive) kept.add(root.path);
		if (kept.size > this.maxDirectories) return null;
		while (pending.length) {
			const dir = pending.pop()!;
			if (traversed.has(dir)) continue;
			if (!kept.has(dir) && kept.size >= this.maxDirectories) return null;
			traversed.add(dir);
			kept.add(dir);
			const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
			if (state.subscriptions.size && !state.subscriptions.has(`f:${dir}`)) {
				for (const entry of entries) if (entry.isFile()) this.queue(state, join(dir, entry.name));
			}
			const dirs = entries.filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name)).filter(path => !excluded(path));
			const ignored = await ignoredPaths(dir, dirs.filter(path => !this.named(state, path)));
			pending.push(...dirs.filter(path => !ignored.has(path)));
		}
		return [...kept].map(path => ({ path, recursive: false }));
	}

	private async subscribe(state: Watch): Promise<void> {
		let roots = this.platform === "linux" ? state.roots : state.roots.filter((root, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.recursive && inside(other.path, root.path) && (other.path !== root.path || otherIndex < index)));
		if (this.platform === "linux") {
			const walked = await this.linuxRoots(state, roots);
			if (walked) roots = walked;
			else {
				// A large project falls back to explicit paths, keeping named files inside ignored folders.
				state.roots = state.roots.filter(root => !root.recursive || state.namedFolders.has(root.path));
				const namedRoots = await this.linuxRoots(state, state.roots);
				roots = namedRoots ?? await Promise.all([...state.namedFiles].map(async path => ({ path: await existingParent(path), recursive: false })));
				if (!namedRoots) state.roots = roots;
			}
			roots = roots.slice(0, this.maxDirectories);
		}
		if (state.closed || state.ending) return;
		// A resubscription follows a new folder; files written before its subscription existed send no event.
		const resubscribing = state.subscriptions.size > 0;
		const added: string[] = [];
		const desired = new Map(roots.map(root => [rootKey(root), root]));
		for (const key of state.subscriptions) if (!desired.has(key)) this.release(state, key);
		for (const [key, root] of desired) {
			if (state.subscriptions.has(key)) continue;
			if (!root.recursive) added.push(root.path);
			let subscription = this.subscriptions.get(key);
			if (!subscription) {
				try {
					const watcher = this.fsWatch(root.path, { recursive: root.recursive, persistent: false }, (_event, filename) => {
						const current = this.subscriptions.get(key);
						if (!current) return;
						for (const user of current.users) {
							if (user.closed) continue;
							if (!user.ending) this.touch(user);
							if (filename !== null) {
								const path = resolve(root.path, filename.toString());
								if (inside(root.path, path)) this.queue(user, path);
								const followsMissing = [...user.missingNamed, ...user.missingSequences].some(named => inside(path, named) || inside(named, path));
								if (!excluded(path) && (followsMissing || (this.platform === "linux" && _event === "rename"))) {
									user.updating = user.updating.then(() => this.refreshMissing(user)).catch(() => {});
								}
							} else {
								for (const path of user.namedFiles) this.queue(user, path);
								void this.scanSequences(user);
								if (user.missingNamed.size || user.missingSequences.size) user.updating = user.updating.then(() => this.refreshMissing(user)).catch(() => {});
							}
						}
					});
					subscription = { watcher, users: new Set() };
					watcher.on("error", () => {
						watcher.close();
						for (const user of this.subscriptions.get(key)?.users ?? []) user.subscriptions.delete(key);
						this.subscriptions.delete(key);
					});
					this.subscriptions.set(key, subscription);
				} catch {
					continue;
				}
			}
			subscription.users.add(state);
			state.subscriptions.add(key);
		}
		if (!resubscribing || this.platform !== "linux") return;
		for (const dir of added) {
			const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) if (entry.isFile()) this.queue(state, join(dir, entry.name));
		}
	}
}

/** `options` pass to the service (tests supply a watcher that reports only what they send). */
export function registerPreviewWatch(options: PreviewWatchOptions = {}): void {
	const service = new PreviewWatchService(change => broadcast("preview:changed", change), options);
	const owners = new Map<WebContents, { ids: Set<string>; generation: number }>();
	const ownerFor = (sender: WebContents): { ids: Set<string>; generation: number } => {
		const existing = owners.get(sender);
		if (existing) return existing;
		const owner = { ids: new Set<string>(), generation: 0 };
		owners.set(sender, owner);
		const close = () => {
			owner.generation++;
			for (const id of owner.ids) service.close(id);
			owner.ids.clear();
		};
		sender.on("did-start-navigation", details => {
			if (details.isMainFrame && !details.isSameDocument) close();
		});
		sender.on("render-process-gone", close);
		sender.once("destroyed", () => { close(); owners.delete(sender); });
		return owner;
	};
	handleWithEvent("preview:watch", async (event, request) => {
		const owner = ownerFor(event.sender);
		const generation = owner.generation;
		const id = await service.watch(request);
		if (event.sender.isDestroyed() || owner.generation !== generation) service.close(id);
		else owner.ids.add(id);
		return id;
	});
	handleWithEvent("preview:watchNamed", (event, id, named, sequences) => {
		if (owners.get(event.sender)?.ids.has(id)) return service.watchNamed(id, named, sequences);
	});
	handleWithEvent("preview:unwatch", async (event, id) => {
		const ids = owners.get(event.sender)?.ids;
		if (!ids?.has(id)) return;
		await service.unwatch(id);
		ids.delete(id);
	});
}
