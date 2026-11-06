import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpUpdateNotice, OmpUpdateRun } from "@shared/contracts/updates";
import type { RpcRequestOptions } from "../omp/rpc";
const fake = vi.hoisted(() => ({ prefs: {} as { ompUpdateNotice?: OmpUpdateNotice }, handlers: new Map<string, (...args: unknown[]) => unknown>(), events: [] as { channel: string; value: unknown }[], spawn: vi.fn(), status: vi.fn(), cli: vi.fn(), rpc: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/vomp-omp-update-test", isPackaged: true }, shell: {} }));
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));
vi.mock("../ipc", () => ({ handle: (channel: string, callback: (...args: unknown[]) => unknown) => fake.handlers.set(channel, callback), broadcast: (channel: string, value: unknown) => fake.events.push({ channel, value }) }));
vi.mock("../env", () => ({ userEnv: async () => ({}) }));
vi.mock("../prefs", () => ({ getPrefs: () => fake.prefs, setPrefs: (patch: typeof fake.prefs) => Object.assign(fake.prefs, patch), flushPrefs: vi.fn() }));
vi.mock("../omp/locate", () => ({ ompPath: async () => "/fixture/omp", ompStatus: fake.status }));
vi.mock("../omp/cli", () => ({ runOmp: fake.cli }));
vi.mock("../omp/rpc", () => ({ rpcRequest: fake.rpc }));
vi.mock("./updates/install-switch", () => ({ registerInstallSwitch: vi.fn() }));
beforeEach(async () => {
	vi.resetModules(); vi.useFakeTimers(); fake.handlers.clear(); fake.events.length = 0; fake.spawn.mockReset();
	fake.prefs = {};
	fake.status.mockResolvedValue({ version: "18.17.0" });
	fake.cli.mockResolvedValue({ code: 0, stdout: "Current version: 18.17.0\nAlready up to date", stderr: "" });
	// Reset updater module state for each lifecycle; a static import would retain the previous run.
	(await import("./updates")).register();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function child() { return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }); }
const invoke = (channel: string, ...args: unknown[]) => fake.handlers.get(`updates:omp:${channel}`)!(...args);
describe("omp updater ownership", () => {
	it("reports concurrent installer refusal and permits a fresh retry", async () => {
		const refused = child(); fake.spawn.mockReturnValueOnce(refused);
		await invoke("run");
		refused.stderr.emit("data", Buffer.from("Failed to update: Another omp update is already running; try again once it finishes.\n"));
		refused.emit("close", 1);
		await vi.advanceTimersByTimeAsync(0);
		expect(await invoke("lastRun")).toMatchObject({ installBusy: true, exitCode: 1, versionAfter: "18.17.0" });
		const retry = child(); fake.spawn.mockReturnValueOnce(retry);
		const started = await invoke("run") as OmpUpdateRun;
		expect(started.finishedAt).toBeNull(); expect(fake.spawn).toHaveBeenCalledTimes(2);
		retry.emit("close", 0); await vi.advanceTimersByTimeAsync(0);
		expect(await invoke("lastRun")).toMatchObject({ installBusy: false, exitCode: 0 });
	});
	it("reads the installed version even when the network check fails", async () => {
		fake.cli.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "Failed to check for updates: offline" });
		await invoke("check", true);
		expect(fake.events).toContainEqual({ channel: "updates:omp:installed", value: { version: "18.17.0" } });
	});
	it("persists pending notes and acknowledgment across app launches", async () => {
		fake.status.mockResolvedValueOnce({ version: "18.16.0" });
		await invoke("installed");
		expect(await invoke("notice")).toMatchObject({ pendingVersion: null });
		await invoke("installed");
		expect(await invoke("notice")).toMatchObject({ observedVersion: "18.17.0", pendingVersion: "18.17.0" });
		// Simulate a new main process while retaining the on-disk preferences mock.
		vi.clearAllTimers(); vi.resetModules(); (await import("./updates")).register();
		await invoke("installed");
		expect(await invoke("notice")).toMatchObject({ pendingVersion: "18.17.0" });
		await invoke("acknowledge", "18.17.0");
		vi.clearAllTimers(); vi.resetModules(); (await import("./updates")).register();
		await invoke("installed");
		expect(await invoke("notice", "18.17.0")).toMatchObject({ pendingVersion: null, acknowledgedVersion: "18.17.0" });
	});
	it("opens notes through installed omp's local changelog command", async () => {
		fake.rpc.mockImplementationOnce(async (_folder: string, _type: string, options: RpcRequestOptions) => {
			options.onMessage?.({ type: "command_output", text: "# 18.17.0\nChanges" });
			return { agentInvoked: false };
		});
		expect(await invoke("notes")).toBe("# 18.17.0\nChanges");
		expect(fake.rpc).toHaveBeenCalledWith(expect.any(String), "prompt", expect.objectContaining({ flags: expect.arrayContaining(["--no-session", "--no-tools", "--no-extensions"]) }), { message: "/changelog last 1" });
	});
});
