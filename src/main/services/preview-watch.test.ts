import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { type FSWatcher, watch as fsWatch } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { PreviewChange } from "@shared/contracts/preview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), broadcast: vi.fn() }));
vi.mock("../ipc", () => ({
	handleWithEvent: (channel: string, handler: (...args: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
	broadcast: ipc.broadcast,
}));
vi.mock("../env", () => ({ userEnv: async () => ({ ...process.env }) }));

import { type PreviewWatchOptions, PreviewWatchService, registerPreviewWatch } from "./preview-watch";

let dir: string;
let changes: PreviewChange[];
let services: { service: PreviewWatchService; ids: string[] }[];
/** Paths the OS has reported to a real watcher in this test. */
let reportedPaths: Set<string>;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "vomp-preview-watch-")));
	changes = [];
	services = [];
	reportedPaths = new Set();
	ipc.handlers.clear();
	ipc.broadcast.mockClear();
});
afterEach(async () => {
	for (const { service, ids } of services) for (const id of ids) service.close(id);
	vi.useRealTimers();
	await rm(dir, { recursive: true, force: true });
});

/**
 * These tests use the OS's real file events, which arrive seconds late when the machine is busy (as when the full
 * suite runs in parallel). The wait returns as soon as the count arrives, so the budget only matters when events
 * are late; each test's limit leaves room for several such waits.
 */
const EVENT_WAIT_MS = 15_000;
const TEST_LIMIT_MS = 60_000;
const eventually = (count: number) => expect.poll(() => changes.length, { timeout: EVENT_WAIT_MS, interval: 25 }).toBe(count);

type Watch = NonNullable<PreviewWatchOptions["watch"]>;
/** Marks a watcher that only reports what its test sends, so `start` does not wait for the OS. */
const CONTROLLED = Symbol("controlled watch");

/** Passes events through, recording what the OS reported and which folders were subscribed. */
function observe(inner: Watch, subscribed: string[]): Watch {
	return (path, options, listener) => {
		subscribed.push(path);
		return inner(path, options, (event, filename) => {
			if (filename !== null) reportedPaths.add(join(path, filename));
			listener(event, filename);
		});
	};
}

let probes = 0;
/**
 * The OS starts delivering a new watcher's events a moment after it is created, and under load a save made in that
 * gap is never reported. Each newly subscribed folder gets a non-visual probe file, rewritten until the OS reports
 * it (a probe written in the gap is lost too), and the test continues once it has.
 */
async function live(folders: string[]): Promise<void> {
	for (const folder of new Set(folders.splice(0))) {
		const probe = join(folder, `probe-${++probes}.txt`);
		// Real OS events have no signal to await but the report itself, so the probe is rewritten on a short interval.
		for (let writes = 1; !reportedPaths.has(probe); writes++) {
			try {
				await writeFile(probe, String(writes));
			} catch (error) {
				// A folder the test has since removed has nothing left to report; any other failure is the test's.
				if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
				throw error;
			}
			if (writes * 100 > EVENT_WAIT_MS) throw new Error(`The OS did not report ${probe} within ${EVENT_WAIT_MS} ms`);
			await delay(100);
		}
	}
}

async function start(folder = dir, named: string[] = [], options: ConstructorParameters<typeof PreviewWatchService>[1] = {}) {
	const inner = options.watch ?? fsWatch;
	const real = !(CONTROLLED in inner);
	const subscribed: string[] = [];
	const service = new PreviewWatchService(change => changes.push(change), { ...options, watch: observe(inner, subscribed) });
	const entry = { service, ids: [] as string[] };
	services.push(entry);
	const id = await service.watch({ folder, named });
	entry.ids.push(id);
	if (real) {
		await live(subscribed);
		// Folders a later scope subscribes are waited for the same way.
		const watchNamed = service.watchNamed.bind(service);
		service.watchNamed = async (watchId, paths) => {
			await watchNamed(watchId, paths);
			await live(subscribed);
		};
	}
	return { service, id };
}

/** Exercise Linux subscription/rescan logic independently of the host OS's native event scheduling. */
function controlledWatch() {
	const listeners = new Map<string, Parameters<Watch>[2]>();
	const watch = vi.fn<Watch>((path, _options, listener) => {
		listeners.set(path, listener);
		return Object.assign(new EventEmitter(), { close: () => { listeners.delete(path); } }) as FSWatcher;
	});
	Object.assign(watch, { [CONTROLLED]: true });
	return {
		watch,
		notify: (path: string, filename: string) => listeners.get(path)!("rename", filename),
		watching: (path: string) => listeners.has(path),
	};
}

describe("preview file watches", { timeout: TEST_LIMIT_MS }, () => {
	it("reports a PNG once after a save becomes stable", async () => {
		await start();
		const file = join(dir, "poster.png");
		await writeFile(file, "first");
		await delay(100);
		await writeFile(file, "completed image");
		await delay(200);
		expect(changes).toEqual([]);
		await eventually(1);
		expect(changes[0]).toMatchObject({ path: file, size: 15 });
		expect(changes[0]?.mtimeMs).toBeGreaterThan(0);
		await delay(500);
		expect(changes).toHaveLength(1);
	});

	it("reports paths in the spelling the chat folder was given, through a symlink such as /tmp", async () => {
		const real = join(dir, "real");
		await mkdir(real);
		const link = join(dir, "link");
		await symlink(real, link);
		await start(link, [join(link, "named.png")]);
		await writeFile(join(real, "poster.png"), "image");
		await writeFile(join(real, "named.png"), "named");
		await eventually(2);
		expect(changes.map(change => change.path).sort()).toEqual([join(link, "named.png"), join(link, "poster.png")]);
	});

	it("reports three successive saves at least one second apart", async () => {
		await start();
		const file = join(dir, "plot.png");
		for (let revision = 1; revision <= 3; revision++) {
			await writeFile(file, "x".repeat(revision));
			await eventually(revision);
			if (revision < 3) await delay(1000);
		}
		expect(changes.map(change => change.size)).toEqual([1, 2, 3]);
	});

	it("ignores non-visual files and directories with visual names", async () => {
		await start();
		await writeFile(join(dir, "notes.txt"), "text");
		await mkdir(join(dir, "folder.png"));
		await writeFile(join(dir, "valid.PDF"), "%PDF");
		await eventually(1);
		await delay(500);
		expect(changes.map(change => change.path)).toEqual([join(dir, "valid.PDF")]);
	});

	it.each(["darwin", "linux"] as const)("keeps named outputs in ignored folders on %s", async platform => {
		execFileSync("git", ["init", "-q", dir]);
		await writeFile(join(dir, ".gitignore"), "dist/\n");
		await mkdir(join(dir, "dist"));
		const file = join(dir, "dist", "named.png");
		await start(dir, [file], { platform });
		await writeFile(file, "named image");
		await writeFile(join(dir, "dist", "ignored.png"), "ignored image");
		await writeFile(join(dir, "visible.png"), "visible image");
		await eventually(2);
		await delay(600);
		expect(changes.map(change => change.path).sort()).toEqual([file, join(dir, "visible.png")].sort());
	});

	it.each([tmpdir(), ...(process.platform !== "win32" ? ["/tmp"] : [])])("watches only named paths for broad chat folder %s", async folder => {
		const watch = vi.fn<NonNullable<PreviewWatchOptions["watch"]>>(fsWatch);
		const file = join(dir, "named.png");
		await start(folder, [file], { watch });
		expect(watch).toHaveBeenCalledTimes(1);
		expect(watch.mock.calls[0]?.slice(0, 2)).toEqual([dir, { recursive: false, persistent: false }]);
		await writeFile(join(dir, "other.png"), "other");
		await writeFile(file, "named");
		await eventually(1);
		await delay(500);
		expect(changes[0]?.path).toBe(file);
	});

	it("never recursively watches broad named folders", async () => {
		const watch = vi.fn<NonNullable<PreviewWatchOptions["watch"]>>(fsWatch);
		await start(tmpdir(), [tmpdir(), parse(dir).root, homedir()], { watch });
		expect(watch).not.toHaveBeenCalled();
	});

	it("watches non-broad named folders recursively", async () => {
		const watch = vi.fn<NonNullable<PreviewWatchOptions["watch"]>>(fsWatch);
		await start(tmpdir(), [dir], { watch, platform: "darwin" });
		expect(watch.mock.calls[0]?.slice(0, 2)).toEqual([dir, { recursive: true, persistent: false }]);
		await mkdir(join(dir, "nested"));
		await writeFile(join(dir, "nested", "chart.svg"), "<svg/>");
		await eventually(1);
	});

	it.each(["darwin", "linux"] as const)("discovers images in a named directory created after a broad-folder watch on %s", async platform => {
		const output = join(dir, "new", "output");
		await start(tmpdir(), [output], { platform });
		const nested = join(output, "nested");
		await mkdir(nested, { recursive: true });
		const image = join(nested, "plot.png");
		await writeFile(image, "saved while creating directories");
		await eventually(1);
		expect(changes[0]).toMatchObject({ path: image, size: 32 });
		await writeFile(join(dir, "unrelated.png"), "outside the named scope");
		await writeFile(image, "updated image");
		await eventually(2);
		expect(changes[1]).toMatchObject({ path: image, size: 13 });
	});

	it.each(["darwin", "linux"] as const)("follows missing parents of a named image and keeps the renderer's spelling on %s", async platform => {
		const link = join(dir, "link");
		const real = join(dir, "real");
		await mkdir(real);
		await symlink(real, link);
		const named = join(link, "new", "nested", "plot.png");
		await start(tmpdir(), [named], { platform });
		await mkdir(join(real, "new"));
		// Leave the image absent long enough for the watch to move to the intermediate parent.
		await delay(500);
		await mkdir(join(real, "new", "nested"));
		await writeFile(join(real, "new", "nested", "plot.png"), "saved image");
		await writeFile(join(real, "new", "nested", "other.png"), "not named");
		await eventually(1);
		expect(changes[0]).toMatchObject({ path: named, size: 11 });
		await delay(500);
		expect(changes).toHaveLength(1);
	});

	it.each(["file", "folder"] as const)("reports the last save before replacing a named %s without waiting for debounce", async scope => {
		// Controlled events: the save is reported before the handoff starts, and the handoff publishes it at once.
		const { watch, notify, watching } = controlledWatch();
		const first = join(dir, "first.png");
		const secondDir = join(dir, "second");
		await mkdir(secondDir);
		const second = join(secondDir, "second.png");
		const { service, id } = await start(tmpdir(), [scope === "file" ? first : dir], { watch });
		await writeFile(first, "completed call's final image");
		notify(dir, "first.png");
		await service.watchNamed(id, [second]);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ path: first, size: 28 });
		await writeFile(first, "retired scope");
		if (watching(dir)) notify(dir, "first.png");
		await writeFile(second, "new output");
		notify(secondDir, "second.png");
		await eventually(2);
		await delay(500);
		expect(changes.map(change => change.path)).toEqual([first, second]);
	});

	it.each(["darwin", "linux"] as const)("reports an incoming folder's save during named-scope handoff on %s", async platform => {
		const incoming = join(dir, "incoming");
		await mkdir(incoming);
		const { service, id } = await start(tmpdir(), [join(dir, "outgoing.png")], { platform });
		const replacing = service.watchNamed(id, [incoming]);
		const image = join(incoming, "during-handoff.png");
		await writeFile(image, "saved before watchNamed resolves");
		await replacing;
		await eventually(1);
		expect(changes[0]).toMatchObject({ path: image, size: 32 });
		await writeFile(image, "next save");
		await eventually(2);
		expect(changes[1]).toMatchObject({ path: image, size: 9 });
	});

	it("replaces named paths without keeping removed subscriptions", async () => {
		const first = join(dir, "first.png");
		const secondDir = join(dir, "second");
		await mkdir(secondDir);
		const second = join(secondDir, "second.png");
		const { service, id } = await start(tmpdir(), [first]);
		await service.watchNamed(id, [second]);
		await writeFile(first, "old output");
		await writeFile(second, "new output");
		await eventually(1);
		await delay(500);
		expect(changes[0]?.path).toBe(second);
	});

	it("performs a final stable read and stops events after unwatch", async () => {
		const file = join(dir, "last.png");
		const { service, id } = await start(dir, [file]);
		await writeFile(file, "final save");
		await service.unwatch(id);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ path: file, size: 10 });
		await writeFile(file, "after stopping");
		await delay(700);
		expect(changes).toHaveLength(1);
		await service.unwatch("unknown");
		await service.watchNamed("unknown", []);
	});

	it("includes an unnamed save whose event arrives during the final debounce", async () => {
		const file = join(dir, "discovered.png");
		const { watch, notify } = controlledWatch();
		const { service, id } = await start(dir, [], { watch });
		await writeFile(file, "last write");
		const stopping = service.unwatch(id);
		notify(dir, "discovered.png");
		await stopping;
		expect(changes).toHaveLength(1);
		expect(changes[0]?.path).toBe(file);
	});

	it("shares subscriptions until the last turn releases them", async () => {
		const watch = vi.fn<NonNullable<PreviewWatchOptions["watch"]>>(fsWatch);
		const { service, id } = await start(dir, [], { watch });
		const second = await service.watch({ folder: dir, named: [] });
		services[0]!.ids.push(second);
		expect(watch).toHaveBeenCalledTimes(1);
		await service.unwatch(id);
		await writeFile(join(dir, "remaining.png"), "still watched");
		await eventually(1);
		expect(changes[0]?.watchId).toBe(second);
	});

	it("walks Linux folders without subscribing to excluded or ignored directories", async () => {
		execFileSync("git", ["init", "-q", dir]);
		await writeFile(join(dir, ".gitignore"), "build/\n");
		for (const folder of ["kept", "node_modules", "build"]) await mkdir(join(dir, folder));
		const { watch, notify } = controlledWatch();
		await start(dir, [], { platform: "linux", watch });
		expect(watch.mock.calls.map(([path]) => path).sort()).toEqual([dir, join(dir, "kept")].sort());
		expect(watch.mock.calls.every(([, options]) => !options.recursive)).toBe(true);
		await writeFile(join(dir, "kept", "image.png"), "kept");
		notify(join(dir, "kept"), "image.png");
		await eventually(1);
	});

	it("falls back to named paths when the Linux directory cap is reached", async () => {
		await mkdir(join(dir, "one"));
		await mkdir(join(dir, "two"));
		const file = join(dir, "one", "named.png");
		const watch = vi.fn<NonNullable<PreviewWatchOptions["watch"]>>(fsWatch);
		await start(dir, [file], { platform: "linux", watch, maxDirectories: 2 });
		expect(watch.mock.calls.map(([path]) => path)).toEqual([join(dir, "one")]);
		await writeFile(file, "named");
		await writeFile(join(dir, "two", "other.png"), "other");
		await eventually(1);
		expect(changes[0]?.path).toBe(file);
	});

	it("finds an image saved while a new Linux directory is being subscribed", async () => {
		const { watch, notify } = controlledWatch();
		await start(dir, [], { platform: "linux", watch });
		const nested = join(dir, "new");
		await mkdir(nested);
		await writeFile(join(nested, "image.png"), "created with folder");
		// Deliver only the parent event. No child file event exists until its folder is subscribed.
		notify(dir, "new");
		await eventually(1);
		expect(changes[0]?.path).toBe(join(nested, "image.png"));
	});

	it("closes subscriptions after four hours without activity", async () => {
		// Any file event counts as activity and restarts the four hours. A real watcher can deliver the temp folder's own
		// creation late, during the advance below, so this test uses a watcher that only reports what the test sends.
		const { watch } = controlledWatch();
		const { service, id } = await start(tmpdir(), [join(dir, "output.png")], { watch });
		const watcher = watch.mock.results[0]!.value;
		const close = vi.spyOn(watcher, "close");
		vi.useFakeTimers();
		await service.watchNamed(id, [join(dir, "output.png")]);
		await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
		expect(close).toHaveBeenCalledOnce();
	});
});

describe("preview watch IPC lifecycle", { timeout: TEST_LIMIT_MS }, () => {
	it.each(["reload", "renderer exit", "destroyed"])("closes a window's watches on %s", async trigger => {
		registerPreviewWatch();
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
		const event = { sender: sender as unknown as WebContents } as IpcMainInvokeEvent;
		const invoke = (channel: string, ...args: unknown[]) => ipc.handlers.get(channel)!(event, ...args);
		const id = await invoke("preview:watch", { folder: dir, named: [] });
		if (trigger === "reload") sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
		else sender.emit(trigger === "renderer exit" ? "render-process-gone" : "destroyed");
		await writeFile(join(dir, "after.png"), "closed");
		await delay(600);
		expect(ipc.broadcast).not.toHaveBeenCalled();
		await invoke("preview:unwatch", id);
	});

	it("broadcasts stable files and prevents a different renderer from stopping the watch", async () => {
		// Controlled events: this test is about which renderer owns the watch, not how quickly the OS reports a save.
		const { watch, notify } = controlledWatch();
		registerPreviewWatch({ watch });
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
		const other = Object.assign(new EventEmitter(), { isDestroyed: () => false });
		const event = { sender: sender as unknown as WebContents } as IpcMainInvokeEvent;
		const otherEvent = { sender: other as unknown as WebContents } as IpcMainInvokeEvent;
		const path = join(dir, "broadcast.png");
		const id = await ipc.handlers.get("preview:watch")!(event, { folder: tmpdir(), named: [path] });
		await ipc.handlers.get("preview:unwatch")!(otherEvent, id);
		await ipc.handlers.get("preview:watchNamed")!(otherEvent, id, []);
		await writeFile(path, "saved");
		notify(dir, "broadcast.png");
		await expect.poll(() => ipc.broadcast.mock.calls.length, { timeout: EVENT_WAIT_MS }).toBe(1);
		expect(ipc.broadcast).toHaveBeenCalledWith("preview:changed", expect.objectContaining({ watchId: id, path, size: 5 }));
		await ipc.handlers.get("preview:unwatch")!(event, id);
	});

	it("closes a watch requested just before the renderer reloads", async () => {
		registerPreviewWatch();
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
		const event = { sender: sender as unknown as WebContents } as IpcMainInvokeEvent;
		const pending = ipc.handlers.get("preview:watch")!(event, { folder: dir, named: [] });
		sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
		await pending;
		await writeFile(join(dir, "after.png"), "closed");
		await delay(600);
		expect(ipc.broadcast).not.toHaveBeenCalled();
	});
});
