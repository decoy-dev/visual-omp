import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Static imports cannot exercise profile/preferences initialization and native startup across reloads.
const fake = vi.hoisted(() => ({
	folder: "", prefs: { classicPresentation: false, sendCrashReports: true },
	start: vi.fn(), setUpload: vi.fn(), setPath: vi.fn(), exit: vi.fn(),
	metrics: vi.fn(), events: new Map<string, (...args: unknown[]) => void>(),
	preferences: null as null | ((prefs: { classicPresentation: boolean; sendCrashReports: boolean }) => void),
	crashPreparation: null as Promise<unknown> | null,
}));
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		mkdir: (path: string, options: { recursive?: boolean }) => {
			if (/[/\\]crashes$/.test(path) && fake.crashPreparation) return fake.crashPreparation;
			return actual.mkdir(path, options);
		},
	};
});
vi.mock("electron", () => ({
	app: {
		getPath: () => fake.folder, getVersion: () => "0.7.7", isPackaged: false,
		setPath: fake.setPath, exit: fake.exit, getAppMetrics: fake.metrics,
		on: (name: string, callback: (...args: unknown[]) => void) => fake.events.set(name, callback),
		once: (name: string, callback: (...args: unknown[]) => void) => fake.events.set(name, callback),
	},
	crashReporter: { start: fake.start, setUploadToServer: fake.setUpload },
}));
vi.mock("../../prefs", () => ({ getPrefs: () => fake.prefs }));
vi.mock("../../ipc", () => ({ onBroadcast: (_event: string, callback: typeof fake.preferences) => { fake.preferences = callback; } }));

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	fake.events.clear();
	fake.crashPreparation = null;
	fake.folder = await mkdtemp(join(tmpdir(), "vomp-runtime-"));
	fake.prefs = { classicPresentation: false, sendCrashReports: true };
	vi.stubEnv("VOMP_SENTRY_DSN", "https://publickey@sentry.example/123");
	vi.stubEnv("VOMP_TSP", "");
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
	// Inspect observation registration without attaching handlers to Vitest's process.
	const original = process.on.bind(process);
	vi.spyOn(process, "on").mockImplementation(((name: string, callback: (...args: unknown[]) => void) => {
		if (name === "uncaughtExceptionMonitor" || name === "unhandledRejection") { fake.events.set(name, callback); return process; }
		return original(name as never, callback);
	}) as typeof process.on);
});
afterEach(async () => {
	vi.useRealTimers();
	fake.events.get("will-quit")?.();
	const { flushDiagnostics } = await import("./events");
	await flushDiagnostics();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await rm(fake.folder, { recursive: true, force: true });
});
async function load() {
	const runtime = await import("./runtime");
	await runtime.crashReportingReady;
	expect(fake.start).toHaveBeenCalledOnce();
	return runtime;
}
function windowFixture() {
	const window = new EventEmitter();
	const contents = Object.assign(new EventEmitter(), { reload: vi.fn(), isDestroyed: () => false });
	return Object.assign(window, { id: 1, webContents: contents, isDestroyed: () => false });
}

describe("Electron diagnostics wiring", () => {
	it("sets a profile-local dump path before starting native crash reporting and updates the switch", async () => {
		await load();
		expect(fake.setPath).toHaveBeenCalledWith("crashDumps", join(fake.folder, "logs", "crashes"));
		expect(fake.setPath.mock.invocationCallOrder[0]).toBeLessThan(fake.start.mock.invocationCallOrder[0]!);
		expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({
			uploadToServer: true, compress: true, rateLimit: true, submitURL: "https://sentry.example/api/123/minidump/?sentry_key=publickey",
			globalExtra: {
				"sentry[release]": "visual-omp@0.7.7", "sentry[environment]": "development",
				"sentry[tags][platform]": process.platform, "sentry[tags][arch]": process.arch,
				"sentry[tags][transport]": "tsp", "sentry[tags][classic]": "false",
			},
		}));
		fake.preferences?.({ classicPresentation: true, sendCrashReports: false });
		expect(fake.setUpload).toHaveBeenLastCalledWith(false);
		// Native global annotations are immutable; app-event tags follow current preferences.
		fake.preferences?.({ classicPresentation: false, sendCrashReports: true });
		expect(fake.setUpload).toHaveBeenLastCalledWith(true);
	});
	it("abandons native startup after 1.5 seconds and cannot start it after late directory preparation", async () => {
		vi.useFakeTimers();
		const { promise, resolve } = Promise.withResolvers<void>();
		fake.crashPreparation = promise;
		const runtime = await import("./runtime");
		let ready = false;
		void runtime.crashReportingReady.then(() => { ready = true; });
		await vi.advanceTimersByTimeAsync(1499);
		expect(ready).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await runtime.crashReportingReady;
		expect(ready).toBe(true);
		expect(fake.start).not.toHaveBeenCalled();
		resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.start).not.toHaveBeenCalled();
		expect(fake.setPath).not.toHaveBeenCalled();
	});
	it("keeps native uploads off for a saved opt-out", async () => {
		fake.prefs.sendCrashReports = false;
		await load();
		expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ uploadToServer: false }));
	});
	it("keeps development native uploads off without an explicit DSN override", async () => {
		vi.stubEnv("VOMP_SENTRY_DSN", "");
		await load();
		expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ uploadToServer: false }));
	});
	it("reloads a dead renderer once, then records and leaves a rapid second death stopped", async () => {
		const runtime = await load();
		const window = windowFixture();
		runtime.attachWindowDiagnostics(window as unknown as BrowserWindow);
		window.webContents.emit("render-process-gone", {}, { reason: "oom", exitCode: -1 });
		await vi.waitFor(() => expect(window.webContents.reload).toHaveBeenCalledOnce());
		window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
		const { initializeDiagnosticsLog } = await import("./events");
		const text = await initializeDiagnosticsLog(join(fake.folder, "logs", "diagnostics.log")).recent();
		expect(text).toContain('"reload":true');
		expect(text).toContain('"reload":false');
		expect(window.webContents.reload).toHaveBeenCalledOnce();
	});
	it("records unresponsive memory, recovery duration, child crashes and exceptions without exiting", async () => {
		const runtime = await load();
		fake.metrics.mockReturnValue([{ pid: 42, type: "GPU", memory: { workingSetSize: 512 } }]);
		runtime.startDiagnostics({ classic: false, hosts: () => 2 });
		const window = windowFixture();
		runtime.attachWindowDiagnostics(window as unknown as BrowserWindow);
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		window.emit("unresponsive");
		now = 12_000;
		window.emit("responsive");
		fake.events.get("child-process-gone")?.({}, { type: "GPU", reason: "crashed", exitCode: 9, serviceName: "gpu" });
		fake.events.get("uncaughtExceptionMonitor")?.(new TypeError("private chat token"));
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const rejection = new Error("private rejected prompt");
		fake.events.get("unhandledRejection")?.(rejection);
		expect(warning).toHaveBeenCalledWith("[visual-omp] Unhandled promise rejection:", rejection);
		expect(fake.exit).not.toHaveBeenCalled();
		const { initializeDiagnosticsLog } = await import("./events");
		const text = await initializeDiagnosticsLog(join(fake.folder, "logs", "diagnostics.log")).recent();
		expect(text).toContain('"durationMs":12000');
		expect(text).toContain('"hosts":2,"processes":[{"pid":42,"type":"GPU","workingSetKiB":512}]');
		expect(text).toContain('child-gone {"type":"GPU","reason":"crashed","exitCode":9,"serviceName":"gpu"}');
		expect(text).toContain('"kind":"uncaughtException","errorType":"TypeError"');
		expect(text).not.toContain("private chat token");
		expect(text).toContain('"kind":"unhandledRejection","errorType":"Error"');
		expect(text).not.toContain("private rejected prompt");
	});
});
