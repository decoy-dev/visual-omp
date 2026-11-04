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

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "vomp-preview-watch-")));
	changes = [];
	services = [];
	ipc.handlers.clear();
	ipc.broadcast.mockClear();
});
afterEach(async () => {
	for (const { service, ids } of services) for (const id of ids) service.close(id);
	vi.useRealTimers();
	await rm(dir, { recursive: true, force: true });
});

async function start(folder = dir, named: string[] = [], options: ConstructorParameters<typeof PreviewWatchService>[1] = {}) {
	const service = new PreviewWatchService(change => changes.push(change), options);
	const entry = { service, ids: [] as string[] };
	services.push(entry);
	const id = await service.watch({ folder, named });
	entry.ids.push(id);
	return { service, id };
}

const eventually = (count: number) => expect.poll(() => changes.length, { timeout: 4000, interval: 25 }).toBe(count);

/** Exercise Linux subscription/rescan logic independently of the host OS's native event scheduling. */
function controlledWatch() {
	const listeners = new Map<string, Parameters<NonNullable<PreviewWatchOptions["watch"]>>[2]>();
	const watch = vi.fn<NonNullable<PreviewWatchOptions["watch"]>>((path, _options, listener) => {
		listeners.set(path, listener);
		return Object.assign(new EventEmitter(), { close: () => { listeners.delete(path); } }) as FSWatcher;
	});
	return { watch, notify: (path: string, filename: string) => listeners.get(path)!("rename", filename) };
}

describe("preview file watches", () => {
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
	}, 10_000);

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
		const first = join(dir, "first.png");
		const secondDir = join(dir, "second");
		await mkdir(secondDir);
		const second = join(secondDir, "second.png");
		const { service, id } = await start(tmpdir(), [scope === "file" ? first : dir]);
		await writeFile(first, "completed call's final image");
		await service.watchNamed(id, [second]);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ path: first, size: 28 });
		await writeFile(first, "retired scope");
		await writeFile(second, "new output");
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
		const watch = vi.fn<NonNullable<PreviewWatchOptions["watch"]>>(fsWatch);
		const { service, id } = await start(tmpdir(), [join(dir, "output.png")], { watch });
		const watcher = watch.mock.results[0]!.value;
		const close = vi.spyOn(watcher, "close");
		vi.useFakeTimers();
		await service.watchNamed(id, [join(dir, "output.png")]);
		await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
		expect(close).toHaveBeenCalledOnce();
	});
});

describe("preview watch IPC lifecycle", () => {
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
		registerPreviewWatch();
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
		const other = Object.assign(new EventEmitter(), { isDestroyed: () => false });
		const event = { sender: sender as unknown as WebContents } as IpcMainInvokeEvent;
		const otherEvent = { sender: other as unknown as WebContents } as IpcMainInvokeEvent;
		const path = join(dir, "broadcast.png");
		const id = await ipc.handlers.get("preview:watch")!(event, { folder: tmpdir(), named: [path] });
		await ipc.handlers.get("preview:unwatch")!(otherEvent, id);
		await ipc.handlers.get("preview:watchNamed")!(otherEvent, id, []);
		await writeFile(path, "saved");
		await expect.poll(() => ipc.broadcast.mock.calls.length, { timeout: 4000 }).toBe(1);
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
