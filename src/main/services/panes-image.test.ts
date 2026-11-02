import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import type * as FsModule from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readPaneFile } from "./panes";

const race = vi.hoisted(() => ({ afterStat: null as null | ((path: string) => Promise<void>), requested: [] as number[], closed: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
	const fs = await importOriginal<typeof FsModule>();
	return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
		const file = await fs.open(...args);
		const stat = file.stat.bind(file);
		const read = file.read.bind(file);
		const close = file.close.bind(file);
		file.stat = (async () => {
			const info = await stat();
			const hook = race.afterStat;
			race.afterStat = null;
			if (hook) await hook(String(args[0]));
			return info;
		}) as typeof file.stat;
		file.read = (async (buffer: Uint8Array, offset: number, length: number, position: number) => {
			race.requested.push(length);
			return read(buffer, offset, length, position);
		}) as typeof file.read;
		file.close = async () => { race.closed++; await close(); };
		return file;
	} };
});
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vomp-pane-image-")); race.afterStat = null; race.requested = []; race.closed = 0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("rejects growth after the handle size check without reading more than size plus one", async () => {
	const path = join(dir, "growing.png");
	await writeFile(path, "tiny");
	race.afterStat = async file => { await appendFile(file, Buffer.alloc(8 * 1024 * 1024, 1)); };
	await expect(readPaneFile(path)).rejects.toThrow("image changed");
	expect(race.requested.reduce((sum, value) => sum + value, 0)).toBe(5);
	expect(race.closed).toBe(1);
});
it("reads the already-open image if its pathname is replaced after stat", async () => {
	const path = join(dir, "replaced.png");
	await writeFile(path, "tiny");
	race.afterStat = async file => { await rename(file, `${file}.old`); await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1, 1)); };
	expect(await readPaneFile(path)).toEqual({ kind: "image", dataUrl: "data:image/png;base64,dGlueQ==", size: 4 });
	expect(race.requested.every(value => value <= 5)).toBe(true);
	expect(race.closed).toBe(1);
});
it("rejects an oversized image before allocating its content buffer", async () => {
	const path = join(dir, "large.png");
	await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1, 1));
	expect(await readPaneFile(path)).toMatchObject({ kind: "tooLarge", limit: 8 * 1024 * 1024 });
	expect(race.requested).toEqual([]);
	expect(race.closed).toBe(1);
});
