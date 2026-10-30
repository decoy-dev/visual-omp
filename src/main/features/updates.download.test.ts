import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AppDownload } from "@shared/contracts/updates";
import { installerName } from "../services/updates";
import type { Platform } from "@shared/ipc";

const fake = vi.hoisted(() => ({
	root: "", version: 1, currentVersion: "0.0.1", digest: "", sizeOffset: 0, writeLimit: Infinity, writeCalls: 0,
	failPendingWrite: false, failPendingCleanup: false, preferenceWriteFailures: 0, openPath: vi.fn(),
	events: [] as AppDownload[], handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			const path = String(args[0]);
			if (fake.failPendingWrite && path.includes("update-pending.json.")) throw new Error("Pending record write failed");
			if (fake.preferenceWriteFailures > 0 && path.endsWith("preferences.json.tmp")) {
				fake.preferenceWriteFailures--;
				throw new Error("Preference write failed");
			}
			return actual.writeFile(...args);
		},
		rm: async (...args: Parameters<typeof actual.rm>) => {
			if (fake.failPendingCleanup && String(args[0]).endsWith("update-pending.json")) {
				fake.failPendingCleanup = false;
				throw new Error("Pending record cleanup failed");
			}
			return actual.rm(...args);
		},
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
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => fake.root, getVersion: () => fake.currentVersion, on: vi.fn(), quit: vi.fn() }, shell: { openPath: fake.openPath } }));
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
				assets: [{ name, browser_download_url: `https://github.com/decoy-dev/visual-omp/releases/download/v${version}/${name}`, size: bytes.length + fake.sizeOffset, digest: fake.digest }],
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

it.skipIf(!installerName("1.0.0", process.platform as Platform, process.arch))("rejects an installer whose byte count differs from the release metadata", async () => {
	fake.version++;
	fake.events.length = 0;
	fake.sizeOffset = 1;
	fake.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	try {
		await fake.handlers.get("updates:app:check")!(true);
		const started = await fake.handlers.get("updates:app:download")!() as AppDownload;
		await expect.poll(() => fake.events.at(-1)?.state).toBe("failed");
		expect(fake.events.at(-1)?.error).toContain("size did not match");
		await expect(access(started.filePath)).rejects.toThrow();
		await expect(access(`${started.filePath}.download`)).rejects.toThrow();
	} finally {
		fake.sizeOffset = 0;
	}
});

// Preferences capture app.getPath at initialization, so these fixtures load it only after beforeAll creates the profile.
async function prepareRollback(previousSkip: string | null = null): Promise<void> {
	fake.currentVersion = "2.0.0";
	fake.version++;
	fake.events.length = 0;
	fake.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	const { setPrefs, flushPrefs } = await import("../prefs");
	setPrefs({ appUpdateSkipThrough: previousSkip });
	await flushPrefs();
	fake.openPath.mockReset();
	await fake.handlers.get("updates:app:download")!(`1.0.${fake.version}`);
	await expect.poll(() => fake.events.at(-1)?.state).toBe("done");
}

async function resetRollback(): Promise<void> {
	fake.failPendingWrite = false;
	fake.failPendingCleanup = false;
	fake.preferenceWriteFailures = 0;
	fake.currentVersion = "0.0.1";
	const { setPrefs, flushPrefs } = await import("../prefs");
	setPrefs({ appUpdateSkipThrough: null });
	await flushPrefs();
	await rm(join(fake.root, "update-pending.json"), { force: true });
}

it.skipIf(!installerName("1.0.0", process.platform as Platform, process.arch)).each([null, "3.0.0"])("persists rollback boundary with prior skip %s and pending version before opening the installer", async previousSkip => {
	await prepareRollback(previousSkip);
	let opened = false;
	fake.openPath.mockImplementation(async () => {
		const preferences = JSON.parse(await readFile(join(fake.root, "preferences.json"), "utf8"));
		const pending = JSON.parse(await readFile(join(fake.root, "update-pending.json"), "utf8"));
		expect(preferences.appUpdateSkipThrough).toBe(previousSkip ?? "2.0.0");
		expect(pending).toMatchObject({ from: "2.0.0", to: `1.0.${fake.version}` });
		opened = true;
		return "";
	});
	try {
		await fake.handlers.get("updates:app:runInstaller")!();
		expect(opened).toBe(true);
	} finally {
		await resetRollback();
	}
});

it.skipIf(!installerName("1.0.0", process.platform as Platform, process.arch)).each(
	["open", "pending", "preferences", "cleanup"].flatMap(failure => [null, "3.0.0"].map(previousSkip => ({ failure, previousSkip }))),
)("restores prior boundary $previousSkip after a $failure failure", async ({ failure, previousSkip }) => {
	await prepareRollback(previousSkip);
	const { getPrefs } = await import("../prefs");
	fake.openPath.mockResolvedValue("Installer launch failed");
	fake.failPendingWrite = failure === "pending";
	fake.preferenceWriteFailures = failure === "preferences" ? 1 : 0;
	fake.failPendingCleanup = failure === "cleanup";
	try {
		await expect(fake.handlers.get("updates:app:runInstaller")!()).rejects.toThrow();
		expect(getPrefs().appUpdateSkipThrough).toBe(previousSkip);
		expect(JSON.parse(await readFile(join(fake.root, "preferences.json"), "utf8")).appUpdateSkipThrough).toBe(previousSkip);
		if (failure === "pending" || failure === "preferences") expect(fake.openPath).not.toHaveBeenCalled();
		if (failure !== "cleanup") await expect(access(join(fake.root, "update-pending.json"))).rejects.toThrow();
	} finally {
		await resetRollback();
	}
});
