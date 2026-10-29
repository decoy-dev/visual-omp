import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AppDownload } from "@shared/contracts/updates";
import { installerName } from "../services/updates";
import type { Platform } from "@shared/ipc";

const fake = vi.hoisted(() => ({ root: "", version: 1, digest: "", writeLimit: Infinity, writeCalls: 0, events: [] as AppDownload[], handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const file = await actual.open(...args);
			const write = file.write.bind(file);
			vi.spyOn(file, "write").mockImplementation((async (value: Uint8Array, offset = 0, length = value.byteLength - offset) => {
				fake.writeCalls++;
				return write(value, offset, Math.min(length, fake.writeLimit));
			}) as typeof file.write);
			return file;
		},
	};
});
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => fake.root, getVersion: () => "0.0.1", on: vi.fn() }, shell: {} }));
vi.mock("../attention", () => ({ tagScoopShortcut: vi.fn() }));
vi.mock("../env", () => ({ userEnv: async () => ({}) }));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => fake.handlers.set(channel, handler), broadcast: (channel: string, value: AppDownload) => { if (channel === "updates:app:download") fake.events.push({ ...value }); } }));
vi.mock("../omp/cli", () => ({ runOmp: vi.fn() }));
vi.mock("../omp/locate", () => ({ ompPath: vi.fn(), ompStatus: vi.fn() }));
vi.mock("../omp/refused", () => ({ ompStartError: vi.fn() }));
const bytes = new TextEncoder().encode("downloaded installer bytes");

beforeAll(async () => {
	fake.root = await mkdtemp(join(tmpdir(), "vomp-download-integrity-"));
	vi.stubGlobal("fetch", vi.fn(async (raw: URL | string) => {
		if (String(raw).startsWith("https://api.github.com/")) {
			const version = `1.0.${fake.version}`;
			const name = installerName(version, process.platform as Platform, process.arch)!;
			return Response.json([{
				tag_name: `v${version}`, html_url: `https://github.com/decoy-dev/visual-omp/releases/tag/v${version}`, draft: false, prerelease: false,
				assets: [{ name, browser_download_url: `https://github.com/decoy-dev/visual-omp/releases/download/v${version}/${name}`, size: bytes.length, digest: fake.digest }],
			}]);
		}
		return new Response(bytes);
	}));
	// Module initialization fixes cache paths from app.getPath, so the fixture must exist first.
	vi.useFakeTimers();
	(await import("./updates")).register();
	vi.clearAllTimers();
	vi.useRealTimers();
});
afterAll(async () => { vi.unstubAllGlobals(); await rm(fake.root, { recursive: true, force: true }); });

it.skipIf(!installerName("1.0.0", process.platform as Platform, process.arch))("promotes only a matching installer and removes a mismatched partial download", async () => {
	for (const matches of [true, false]) {
		fake.version++;
		fake.events.length = 0;
		fake.digest = `sha256:${matches ? createHash("sha256").update(bytes).digest("hex") : "0".repeat(64)}`;
		await fake.handlers.get("updates:app:check")!(true);
		const started = await fake.handlers.get("updates:app:download")!() as AppDownload;
		await expect.poll(() => fake.events.at(-1)?.state).toBe(matches ? "done" : "failed");
		if (matches) expect(await readFile(started.filePath)).toEqual(Buffer.from(bytes));
		else {
			expect(fake.events.at(-1)?.error).toContain("checksum did not match");
			await expect(access(started.filePath)).rejects.toThrow();
			await expect(access(`${started.filePath}.download`)).rejects.toThrow();
		}
	}
});

it.skipIf(!installerName("1.0.0", process.platform as Platform, process.arch))("writes short chunks completely before promoting the verified file", async () => {
	fake.version++;
	fake.events.length = 0;
	fake.writeLimit = 3;
	fake.writeCalls = 0;
	fake.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	try {
		await fake.handlers.get("updates:app:check")!(true);
		const started = await fake.handlers.get("updates:app:download")!() as AppDownload;
		await expect.poll(() => fake.events.at(-1)?.state).toBe("done");
		expect(fake.writeCalls).toBe(Math.ceil(bytes.length / fake.writeLimit));
		expect(await readFile(started.filePath)).toEqual(Buffer.from(bytes));
		expect(fake.events.at(-1)?.received).toBe(bytes.length);
	} finally {
		fake.writeLimit = Infinity;
	}
});

it.skipIf(!installerName("1.0.0", process.platform as Platform, process.arch))("fails a zero-progress disk write and removes the partial file", async () => {
	fake.version++;
	fake.events.length = 0;
	fake.writeLimit = 0;
	fake.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	try {
		await fake.handlers.get("updates:app:check")!(true);
		const started = await fake.handlers.get("updates:app:download")!() as AppDownload;
		await expect.poll(() => fake.events.at(-1)?.state).toBe("failed");
		expect(fake.events.at(-1)?.error).toContain("could not be written to disk");
		await expect(access(started.filePath)).rejects.toThrow();
		await expect(access(`${started.filePath}.download`)).rejects.toThrow();
	} finally {
		fake.writeLimit = Infinity;
	}
});
