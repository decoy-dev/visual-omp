import { afterEach, expect, it, vi } from "vitest";
import type { AppInstallOperation, AppUpdateOutcome } from "@shared/contracts/updates";
import type * as UpdateService from "../services/updates";

const fake = vi.hoisted(() => ({
	method: "brew", pendingMethod: "brew", running: "0.7.6", pendingVersion: "0.7.6",
	failure: null as string | null, failureKind: null as "install" | "cleanup" | "launch" | null, bom: false,
	handlers: new Map<string, (...args: unknown[]) => unknown>(), removed: vi.fn(),
	reserve: null as ((kind: AppInstallOperation) => void) | null,
}));
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => "/profile", getVersion: () => fake.running }, shell: {} }));
vi.mock("node:fs/promises", () => ({
	access: async () => { throw new Error("ENOENT"); }, readdir: async () => [], realpath: async (path: string) => path,
	readFile: async (path: string) => {
		if (!path.endsWith("update-pending.json")) throw new Error("ENOENT");
		return (fake.bom ? "\uFEFF" : "") + JSON.stringify({ method: fake.pendingMethod, operation: "switch", from: "0.7.6", to: fake.pendingVersion, at: Date.now(), failure: fake.failure, failureKind: fake.failureKind });
	},
	rm: fake.removed,
}));
vi.mock("../services/updates", async original => ({ ...(await original<typeof UpdateService>()), detectInstallMethod: () => fake.method }));
vi.mock("./updates/install-switch", () => ({ registerInstallSwitch: (deps: { beginOperation(kind: AppInstallOperation): void }) => { fake.reserve = deps.beginOperation; } }));
vi.mock("../attention", () => ({ tagScoopShortcut: vi.fn() }));
vi.mock("../env", () => ({ userEnv: async () => ({}) }));
vi.mock("../files", () => ({ writeText: vi.fn() }));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => fake.handlers.set(channel, handler), broadcast: vi.fn() }));
vi.mock("../omp/cli", () => ({ runOmp: vi.fn() }));
vi.mock("../omp/locate", () => ({ ompPath: vi.fn(), ompStatus: vi.fn() }));
vi.mock("../omp/refused", () => ({ ompStartError: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: () => ({}), setPrefs: vi.fn(), flushPrefs: vi.fn() }));

async function outcome() {
	// Each case needs a fresh install-method cache and handler registration.
	vi.resetModules(); vi.useFakeTimers();
	(await import("./updates")).register();
	vi.clearAllTimers(); vi.useRealTimers();
	return fake.handlers.get("updates:app:outcome")!() as Promise<AppUpdateOutcome>;
}
afterEach(() => {
	fake.method = "brew"; fake.pendingMethod = "brew"; fake.running = "0.7.6"; fake.pendingVersion = "0.7.6";
	fake.failure = null; fake.failureKind = null; fake.bom = false; vi.useRealTimers();
});

it("recognizes a same-version Homebrew adoption", async () => {
	expect(await outcome()).toMatchObject({ operation: "switch", method: "brew", updated: true, running: "0.7.6" });
	expect(fake.removed).toHaveBeenCalledWith("/profile/update-pending.json", { force: true });
});
it("requires the new install method and the target version", async () => {
	fake.method = "dmg";
	expect((await outcome()).updated).toBe(false);
	fake.method = "brew"; fake.running = "0.7.5";
	expect((await outcome()).updated).toBe(false);
});
it("accepts a verified transfer to an older package-manager version", async () => {
	fake.running = "0.7.5"; fake.pendingVersion = "0.7.5";
	expect((await outcome()).updated).toBe(true);
});

it.each(["update", "reinstall", "switch"] as const)("main refuses conflicting entry points while %s is active", async kind => {
	await outcome();
	fake.reserve!(kind);
	for (const channel of ["updates:app:download", "updates:app:beginBrew", "updates:app:runInstaller", "updates:app:resume", "updates:app:quit"]) {
		await expect(Promise.resolve().then(() => fake.handlers.get(channel)!())).rejects.toThrow(/progress/);
	}
	expect(fake.handlers.get("updates:app:operation")!()).toBe(kind);
});

it("accepts the UTF-8 BOM written by Windows PowerShell and recognizes a Scoop switch", async () => {
	fake.method = "scoop"; fake.pendingMethod = "scoop"; fake.bom = true;
	expect(await outcome()).toMatchObject({ operation: "switch", method: "scoop", updated: true });
});
it.each(["install", "cleanup", "launch"] as const)("retains the Windows %s failure without reporting success", async failureKind => {
	fake.method = failureKind === "install" ? "nsis" : "scoop";
	fake.pendingMethod = "scoop";
	fake.failureKind = failureKind; fake.failure = "The switch could not finish.";
	expect(await outcome()).toMatchObject({ updated: false, failureKind, failure: fake.failure });
});
