import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { type FSWatcher, type Stats, watch as fsWatch } from "node:fs";
import { lstat, mkdtemp, mkdir, open, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import type * as Fs from "node:fs/promises";
import type * as Git from "../git/run";
import { homedir, tmpdir } from "node:os";
import { basename, join, parse } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { PreviewChange, PreviewSequencePattern } from "@shared/contracts/preview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), broadcast: vi.fn() }));
const fsCalls = vi.hoisted(() => ({ lstat: vi.fn(), readdir: vi.fn(), realpath: vi.fn() }));
const gitCalls = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof Fs>();
	return { ...actual, ...fsCalls };
});
vi.mock("../git/run", async importOriginal => {
	const actual = await importOriginal<typeof Git>();
	return { ...actual, runGit: gitCalls.run };
});
vi.mock("../ipc", () => ({
	handleWithEvent: (channel: string, handler: (...args: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
	broadcast: ipc.broadcast,
}));
vi.mock("../env", () => ({ userEnv: async () => ({ ...process.env }) }));

import { type PreviewWatchOptions, PreviewWatchService, registerPreviewWatch } from "./preview-watch";
import { videoCommand } from "../../../scripts/live-preview-fixture/server.mjs";

let dir: string;
let changes: PreviewChange[];
let services: { service: PreviewWatchService; ids: string[] }[];
/** Paths the OS has reported to a real watcher in this test. */
let reportedPaths: Set<string>;

beforeEach(async () => {
	const actualFs = await vi.importActual<typeof Fs>("node:fs/promises");
	fsCalls.lstat.mockReset().mockImplementation(actualFs.lstat);
	fsCalls.readdir.mockReset().mockImplementation(actualFs.readdir);
	fsCalls.realpath.mockReset().mockImplementation(actualFs.realpath);
	const actualGit = await vi.importActual<typeof Git>("../git/run");
	gitCalls.run.mockReset().mockImplementation(actualGit.runGit);
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

async function start(folder = dir, named: string[] = [], options: ConstructorParameters<typeof PreviewWatchService>[1] = {}, sequences: PreviewSequencePattern[] = [], rendering: string[] = []) {
	const inner = options.watch ?? fsWatch;
	const real = !(CONTROLLED in inner);
	const subscribed: string[] = [];
	const service = new PreviewWatchService(change => changes.push(change), { ...options, watch: observe(inner, subscribed) });
	const entry = { service, ids: [] as string[] };
	services.push(entry);
	const id = await service.watch({ folder, named, sequences, rendering });
	entry.ids.push(id);
	if (real) {
		await live(subscribed);
		// Folders a later scope subscribes are waited for the same way.
		const watchNamed = service.watchNamed.bind(service);
		service.watchNamed = async (watchId, paths, patterns, active) => {
			await watchNamed(watchId, paths, patterns, active);
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
	it("bounds discovered growing files to thirty seconds even when an ungranted polling exemption is requested", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const events = controlledWatch();
		const file = join(dir, "discovered.mp4");
		await writeFile(file, "first");
		await start(dir, [], { watch: events.watch, platform: "darwin" }, [], [file]);
		events.notify(dir, "discovered.mp4");
		await eventually(1);
		vi.setSystemTime(Date.now() + 31_000);
		const writer = await open(file, "a");
		try { await writer.write("more frames"); } finally { await writer.close(); }
		await eventually(2);
		const reads = fsCalls.lstat.mock.calls.length;
		await delay(1800);
		expect(fsCalls.lstat).toHaveBeenCalledTimes(reads);
	});
	it("stops polling finished files and resumes after a filesystem event", async () => {
		const events = controlledWatch();
		const file = join(dir, "finished.mp4");
		await writeFile(file, "finished");
		await start(dir, [file], { watch: events.watch });
		fsCalls.lstat.mockClear();
		await eventually(1);
		await delay(5000);
		const reads = fsCalls.lstat.mock.calls.length;
		expect(reads).toBeGreaterThanOrEqual(8);
		await delay(1800);
		expect(fsCalls.lstat).toHaveBeenCalledTimes(reads);
		await writeFile(file, "another completed video");
		events.notify(dir, "finished.mp4");
		await eventually(2);
		expect(fsCalls.lstat.mock.calls.length).toBeGreaterThan(reads);
	});
	it("bounds missing-file polling to three samples, then resumes on creation", async () => {
		const events = controlledWatch();
		const file = join(dir, "missing.mp4");
		await start(dir, [file], { watch: events.watch });
		fsCalls.lstat.mockClear();
		await delay(4500);
		const reads = fsCalls.lstat.mock.calls.filter(([path]) => path === file).length;
		expect(reads).toBe(6);
		await delay(1800);
		expect(fsCalls.lstat.mock.calls.filter(([path]) => path === file)).toHaveLength(reads);
		await writeFile(file, "created");
		events.notify(dir, "missing.mp4");
		await eventually(1);
	});
	it("only keeps unchanged files polling while their render is explicitly active", async () => {
		const events = controlledWatch();
		const file = join(dir, "active.mp4");
		await writeFile(file, "render header");
		const { service, id } = await start(dir, [file], { watch: events.watch }, [], [file]);
		fsCalls.lstat.mockClear();
		await delay(6000);
		expect(fsCalls.lstat.mock.calls.filter(([path]) => path === file).length).toBeGreaterThan(10);
		await service.watchNamed(id, [file], [], []);
		await delay(1500);
		const reads = fsCalls.lstat.mock.calls.length;
		await delay(1800);
		expect(fsCalls.lstat).toHaveBeenCalledTimes(reads);
	});
	it.each(["ignore", "first stat", "second stat"] as const)("starts no filesystem calls after closure during %s", async phase => {
		const events = controlledWatch();
		const file = join(dir, "closing.mp4");
		await writeFile(file, "header");
		const info = await lstat(file);
		const { service, id } = await start(dir, phase === "ignore" ? [] : [file], { watch: events.watch, platform: "darwin" });
		const entered = Promise.withResolvers<void>();
		const ignored = Promise.withResolvers<Git.RunResult>();
		const stat = Promise.withResolvers<Stats>();
		if (phase === "ignore") gitCalls.run.mockImplementationOnce(() => { entered.resolve(); return ignored.promise; });
		else {
			if (phase === "second stat") {
				const actual = await vi.importActual<typeof Fs>("node:fs/promises");
				fsCalls.lstat.mockImplementationOnce(actual.lstat);
			}
			fsCalls.lstat.mockImplementationOnce(() => { entered.resolve(); return stat.promise; });
		}
		events.notify(dir, "closing.mp4");
		await entered.promise;
		service.close(id);
		const counts = [fsCalls.lstat.mock.calls.length, fsCalls.readdir.mock.calls.length, fsCalls.realpath.mock.calls.length];
		ignored.resolve({ code: 0, stdout: "", stderr: "", aborted: false });
		stat.resolve(info);
		await delay(400);
		expect([fsCalls.lstat.mock.calls.length, fsCalls.readdir.mock.calls.length, fsCalls.realpath.mock.calls.length]).toEqual(counts);
	});
	it.each([false, true])("reports appends through one open file before close, controlled events: %s", async controlled => {
		const file = join(dir, "open-render.mp4");
		const events = controlled ? controlledWatch() : null;
		const { service, id } = await start(dir, [file], events ? { watch: events.watch } : {});
		const writer = await open(file, "w");
		try {
			const chunk = Buffer.alloc(1024);
			for (let frame = 0; frame < 12; frame++) {
				await writer.write(chunk);
				// Some platforms coalesce all later appends until close. Only creation is guaranteed here.
				if (frame === 0) events?.notify(dir, "open-render.mp4");
				await delay(300);
			}
			expect(changes.length).toBeGreaterThanOrEqual(3);
			expect(changes.at(-1)!.size).toBeGreaterThan(changes[0]!.size);
			expect(changes.at(-1)!.size).toBeGreaterThanOrEqual(9 * chunk.length);
			service.close(id);
			const closedCount = changes.length;
			const closedReads = [fsCalls.lstat.mock.calls.length, fsCalls.readdir.mock.calls.length, fsCalls.realpath.mock.calls.length];
			await writer.write(chunk);
			await delay(1100);
			expect(changes).toHaveLength(closedCount);
			expect([fsCalls.lstat.mock.calls.length, fsCalls.readdir.mock.calls.length, fsCalls.realpath.mock.calls.length]).toEqual(closedReads);
		} finally {
			await writer.close();
			await service.unwatch(id);
		}
	});
	it("publishes growing fixture bytes before ffmpeg exits", async context => {
		try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { context.skip(); }
		const command = videoCommand();
		const file = join(dir, "out.mp4");
		let rendering = true;
		const samples: { size: number; rendering: boolean }[] = [];
		const service = new PreviewWatchService(change => {
			changes.push(change);
			samples.push({ size: change.size, rendering });
		});
		const id = await service.watch({ folder: dir, named: [file], sequences: [], rendering: [file] });
		services.push({ service, ids: [id] });
		const child = spawn(command, { cwd: dir, shell: true, stdio: "ignore" });
		try {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			child.once("error", reject);
			child.once("exit", code => { rendering = false; if (code === 0) resolve(); else reject(new Error(`ffmpeg exited ${code}`)); });
			await promise;
			const live = samples.filter(sample => sample.rendering);
			expect(live.length).toBeGreaterThanOrEqual(3);
			expect(live.some(sample => sample.size >= 30_000)).toBe(true);
			for (let index = 1; index < live.length; index++) {
				expect(live[index]!.size).toBeGreaterThan(live[index - 1]!.size);
			}
			console.info("Live video fixture snapshots", live);
		} finally {
			child.kill();
			await service.unwatch(id);
		}
	});
	it("reports a continuously growing video before writes stop", async () => {
		const controlled = controlledWatch();
		const file = join(dir, "growing.mp4");
		const { service, id } = await start(dir, [file], { watch: controlled.watch });
		for (let frame = 1; frame <= 25; frame++) {
			await writeFile(file, "x".repeat(frame * 100));
			controlled.notify(dir, "growing.mp4");
			await delay(80);
		}
		expect(changes.length).toBeGreaterThanOrEqual(2);
		expect(changes[0]!.size).toBeLessThan(changes.at(-1)!.size);
		expect(changes.at(-1)!.size).toBeLessThan(2500);
		await service.unwatch(id);
		expect(changes.at(-1)!.size).toBe(2500);
	});
	it("watches a named completed Manim clip while ignoring unrelated cached clips", async () => {
		const folder = join(dir, "partial_movie_files");
		await mkdir(folder);
		const file = join(folder, "completed.mp4");
		const controlled = controlledWatch();
		await start(dir, [file], { watch: controlled.watch });
		await writeFile(file, "completed clip");
		await writeFile(join(folder, "cached.mp4"), "old cached clip");
		controlled.notify(dir, "partial_movie_files/completed.mp4");
		controlled.notify(dir, "partial_movie_files/cached.mp4");
		await eventually(1);
		expect(changes[0]!.path).toBe(file);
	});
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
		await service.watchNamed(id, [second], []);
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
		const replacing = service.watchNamed(id, [incoming], []);
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
		await service.watchNamed(id, [second], []);
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
		await service.watchNamed("unknown", [], []);
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
		const second = await service.watch({ folder: dir, named: [], sequences: [] });
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
		for (const folder of ["kept", "node_modules", "build", "partial_movie_files"]) await mkdir(join(dir, folder));
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

	it.each(["mp4", "m4v", "webm", "mov"])("reports stable %s video files", async extension => {
		const { watch, notify } = controlledWatch();
		await start(dir, [], { watch });
		const name = `render.${extension}`;
		await writeFile(join(dir, name), "video bytes");
		notify(dir, name);
		await eventually(1);
		expect(changes[0]).toMatchObject({ path: join(dir, name), size: 11 });
	});

	it.each(["darwin", "linux"] as const)("allows only explicitly named partial_movie_files clips on %s", async platform => {
		const partial = join(dir, "partial_movie_files");
		await mkdir(partial);
		const { watch, notify } = controlledWatch();
		await start(dir, [partial, join(partial, "part.mp4")], { watch, platform }, [{ folder: partial, prefix: "", digits: null, suffix: ".png" }]);
		expect(watch.mock.calls.some(([path]) => path === partial)).toBe(platform === "linux");
		await writeFile(join(partial, "part.mp4"), "partial video");
		await writeFile(join(partial, "1.png"), "partial image");
		notify(dir, join("partial_movie_files", "part.mp4"));
		notify(dir, join("partial_movie_files", "1.png"));
		await writeFile(join(dir, "complete.mp4"), "complete");
		notify(dir, "complete.mp4");
		await eventually(2);
		expect(changes.map(change => change.path).sort()).toEqual([join(partial, "part.mp4"), join(dir, "complete.mp4")].sort());
	});

	it("coalesces only declared frames and counts all matching files still present", async () => {
		const { watch, notify } = controlledWatch();
		const pattern = { folder: dir, prefix: "frame-", digits: 4, suffix: ".png" };
		await writeFile(join(dir, "frame-0001.png"), "existing frame");
		await start(dir, [], { watch }, [pattern]);
		await eventually(1);
		expect(changes[0]).toMatchObject({ path: join(dir, "frame-0001.png"), sequence: { pattern, count: 1 } });
		for (const [index, name] of ["frame-0002.png", "frame-0003.png"].entries()) {
			await writeFile(join(dir, name), "new frame");
			await utimes(join(dir, name), new Date(10_000 + index * 1000), new Date(10_000 + index * 1000));
			notify(dir, name);
		}
		// A later write wins even when its frame number is lower.
		await utimes(join(dir, "frame-0002.png"), new Date(20_000), new Date(20_000));
		await utimes(join(dir, "frame-0001.png"), new Date(1_000), new Date(1_000));
		for (const name of ["image1.png", "image2.png", "image3.png"]) {
			await writeFile(join(dir, name), "independent image");
			notify(dir, name);
		}
		await eventually(5);
		expect(changes.filter(change => !change.sequence).map(change => change.path).sort()).toEqual(["image1.png", "image2.png", "image3.png"].map(name => join(dir, name)));
		expect(changes.filter(change => change.sequence)).toHaveLength(2);
		expect(changes.filter(change => change.sequence).at(-1)).toMatchObject({ path: join(dir, "frame-0002.png"), sequence: { pattern, count: 3 } });
		await rm(join(dir, "frame-0001.png"));
		notify(dir, "frame-0001.png");
		await eventually(6);
		expect(changes[5]).toMatchObject({ path: join(dir, "frame-0002.png"), sequence: { pattern, count: 2 } });
	});

	it("uses literal pattern fragments, exact widths and direct regular files only", async () => {
		const { watch, notify } = controlledWatch();
		const pattern = { folder: dir, prefix: "frame[final].", digits: 2, suffix: ".png" };
		await start(tmpdir(), [], { watch }, [pattern]);
		await mkdir(join(dir, "nested"));
		for (const name of ["frame[final].01.png", "frame[final].002.png", "frame[final].ab.png", "framef.03.png"]) {
			await writeFile(join(dir, name), "image");
			notify(dir, name);
		}
		await mkdir(join(dir, "frame[final].04.png"));
		await writeFile(join(dir, "nested", "frame[final].05.png"), "nested image");
		await symlink(join(dir, "frame[final].01.png"), join(dir, "frame[final].06.png"));
		notify(dir, "frame[final].04.png");
		notify(dir, join("nested", "frame[final].05.png"));
		notify(dir, "frame[final].06.png");
		await eventually(1);
		expect(changes[0]).toMatchObject({ path: join(dir, "frame[final].01.png"), sequence: { pattern, count: 1 } });
	});

	it("breaks matching frame timestamp ties by numeric frame order", async () => {
		const { watch } = controlledWatch();
		const pattern = { folder: dir, prefix: "", digits: null, suffix: ".png" };
		for (const name of ["9.png", "10.png"]) {
			await writeFile(join(dir, name), "frame");
			await utimes(join(dir, name), new Date(1000), new Date(1000));
		}
		await start(tmpdir(), [], { watch }, [pattern]);
		await eventually(1);
		expect(changes[0]).toMatchObject({ path: join(dir, "10.png"), sequence: { pattern, count: 2 } });
	});

	it.skipIf(process.platform === "win32")("treats backslashes in POSIX filenames as literal pattern text", async () => {
		const { watch } = controlledWatch();
		const pattern = { folder: dir, prefix: "part\\", digits: 2, suffix: ".png" };
		await writeFile(join(dir, "part\\01.png"), "frame");
		await start(tmpdir(), [], { watch }, [pattern]);
		await eventually(1);
		expect(changes[0]).toMatchObject({ path: join(dir, "part\\01.png"), sequence: { pattern, count: 1 } });
	});

	it.each([
		{ folder: "relative", prefix: "", digits: 2, suffix: ".png" },
		{ folder: "", prefix: "../frame", digits: 2, suffix: ".png" },
		{ folder: "", prefix: "", digits: 0, suffix: ".png" },
		{ folder: "", prefix: "", digits: 1.5, suffix: ".png" },
	])("rejects invalid sequence declarations: %j", async input => {
		const { watch } = controlledWatch();
		const pattern = { ...input, folder: input.folder || dir };
		await expect(start(tmpdir(), [], { watch }, [pattern])).rejects.toThrow("Invalid preview sequences");
		expect(watch).not.toHaveBeenCalled();
	});

	it("reads a final sequence frame on unwatch when no file event arrived", async () => {
		const { watch, watching } = controlledWatch();
		const pattern = { folder: dir, prefix: "frame-", digits: 2, suffix: ".png" };
		const { service, id } = await start(tmpdir(), [], { watch }, [pattern]);
		await writeFile(join(dir, "frame-01.png"), "last frame");
		await service.unwatch(id);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ path: join(dir, "frame-01.png"), sequence: { pattern, count: 1 } });
		expect(watching(dir)).toBe(false);
	});

	it.each(["darwin", "linux"] as const)("promotes a missing sequence folder and preserves its spelling on %s", async platform => {
		const real = join(dir, "real");
		const link = join(dir, "link");
		await mkdir(real);
		await symlink(real, link);
		const pattern = { folder: join(link, "new", "frames"), prefix: "", digits: null, suffix: ".png" };
		const { watch, notify, watching } = controlledWatch();
		await start(tmpdir(), [], { watch, platform }, [pattern]);
		expect(watching(real)).toBe(true);
		await mkdir(join(real, "new"));
		notify(real, "new");
		await expect.poll(() => watching(join(real, "new")), { timeout: EVENT_WAIT_MS }).toBe(true);
		await mkdir(join(real, "new", "frames"));
		await writeFile(join(real, "new", "frames", "1.png"), "first");
		await writeFile(join(real, "new", "frames", "20.png"), "last");
		await utimes(join(real, "new", "frames", "1.png"), new Date(1000), new Date(1000));
		notify(join(real, "new"), "frames");
		await eventually(1);
		expect(changes[0]).toMatchObject({ path: join(pattern.folder, "20.png"), sequence: { pattern, count: 2 } });
		expect(watch.mock.calls.every(([, options]) => !options.recursive)).toBe(true);
		expect(watch.mock.calls.some(([path]) => path === tmpdir())).toBe(false);
	});

	it("watches a declared sequence directly in a broad root without recursion", async () => {
		const { watch, notify } = controlledWatch();
		// A declared pattern narrows the scope even when its folder is itself broad.
		const pattern = { folder: tmpdir(), prefix: `${basename(dir)}-`, digits: 2, suffix: ".png" };
		const output = join(tmpdir(), `${pattern.prefix}01.png`);
		try {
			await start(tmpdir(), [], { watch }, [pattern]);
			expect(watch.mock.calls[0]?.slice(0, 2)).toEqual([await realpath(tmpdir()), { recursive: false, persistent: false }]);
			await writeFile(output, "frame");
			notify(await realpath(tmpdir()), `${pattern.prefix}01.png`);
			await eventually(1);
			expect(changes[0]).toMatchObject({ path: output, sequence: { pattern, count: 1 } });
		} finally {
			await rm(output, { force: true });
		}
	});

	it("flushes the final sequence before replacing its scope", async () => {
		const { watch, notify, watching } = controlledWatch();
		const pattern = { folder: dir, prefix: "frame-", digits: 2, suffix: ".png" };
		const { service, id } = await start(tmpdir(), [], { watch }, [pattern]);
		await writeFile(join(dir, "frame-01.png"), "final frame");
		notify(dir, "frame-01.png");
		await service.watchNamed(id, [], []);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ sequence: { pattern, count: 1 } });
		expect(watching(dir)).toBe(false);
		await writeFile(join(dir, "frame-02.png"), "retired frame");
		await delay(500);
		expect(changes).toHaveLength(1);
	});

	it("closes subscriptions after four hours without activity", async () => {
		// Any file event counts as activity and restarts the four hours. A real watcher can deliver the temp folder's own
		// creation late, during the advance below, so this test uses a watcher that only reports what the test sends.
		const { watch } = controlledWatch();
		const { service, id } = await start(tmpdir(), [join(dir, "output.png")], { watch });
		const watcher = watch.mock.results[0]!.value;
		const close = vi.spyOn(watcher, "close");
		vi.useFakeTimers();
		await service.watchNamed(id, [join(dir, "output.png")], []);
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
		const id = await invoke("preview:watch", { folder: dir, named: [], sequences: [] });
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
		const id = await ipc.handlers.get("preview:watch")!(event, { folder: tmpdir(), named: [path], sequences: [] });
		await ipc.handlers.get("preview:unwatch")!(otherEvent, id);
		await ipc.handlers.get("preview:watchNamed")!(otherEvent, id, [], []);
		await writeFile(path, "saved");
		notify(dir, "broadcast.png");
		await expect.poll(() => ipc.broadcast.mock.calls.length, { timeout: EVENT_WAIT_MS }).toBe(1);
		expect(ipc.broadcast).toHaveBeenCalledWith("preview:changed", expect.objectContaining({ watchId: id, path, size: 5 }));
		await ipc.handlers.get("preview:unwatch")!(event, id);
	});

	it("forwards replacement sequence patterns only for the owning renderer", async () => {
		const { watch, notify } = controlledWatch();
		registerPreviewWatch({ watch });
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
		const other = Object.assign(new EventEmitter(), { isDestroyed: () => false });
		const event = { sender: sender as unknown as WebContents } as IpcMainInvokeEvent;
		const otherEvent = { sender: other as unknown as WebContents } as IpcMainInvokeEvent;
		const id = await ipc.handlers.get("preview:watch")!(event, { folder: tmpdir(), named: [], sequences: [] });
		const pattern = { folder: dir, prefix: "frame-", digits: 2, suffix: ".png" };
		await ipc.handlers.get("preview:watchNamed")!(event, id, [], [pattern]);
		await ipc.handlers.get("preview:watchNamed")!(otherEvent, id, [], []);
		await writeFile(join(dir, "frame-01.png"), "saved frame");
		notify(dir, "frame-01.png");
		await expect.poll(() => ipc.broadcast.mock.calls.length, { timeout: EVENT_WAIT_MS }).toBe(1);
		expect(ipc.broadcast).toHaveBeenCalledWith("preview:changed", expect.objectContaining({ watchId: id, sequence: { pattern, count: 1 } }));
		await ipc.handlers.get("preview:unwatch")!(event, id);
	});

	it("closes a watch requested just before the renderer reloads", async () => {
		registerPreviewWatch();
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
		const event = { sender: sender as unknown as WebContents } as IpcMainInvokeEvent;
		const pending = ipc.handlers.get("preview:watch")!(event, { folder: dir, named: [], sequences: [] });
		sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
		await pending;
		await writeFile(join(dir, "after.png"), "closed");
		await delay(600);
		expect(ipc.broadcast).not.toHaveBeenCalled();
	});
});

it("watches Office saves without admitting macro-enabled extensions", { timeout: TEST_LIMIT_MS }, async () => {
	const controlled = controlledWatch();
	await start(dir, [], { platform: "linux", watch: controlled.watch });
	for (const extension of ["docx", "xlsx", "pptx", "pptm"]) {
		await writeFile(join(dir, `office.${extension}`), "snapshot");
		controlled.notify(dir, `office.${extension}`);
	}
	await eventually(3);
	expect(changes.map(change => basename(change.path)).sort()).toEqual(["office.docx", "office.pptx", "office.xlsx"]);
});
