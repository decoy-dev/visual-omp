import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppInstallInfo, AppInstallSwitchRun } from "@shared/contracts/updates";
import type * as NodePath from "node:path";

const fake = vi.hoisted(() => ({
	method: "dmg" as AppInstallInfo["method"], packaged: true,
	host: "posix" as "posix" | "win32",
	globalRoot: undefined as string | undefined,
	files: new Map<string, string>(), casks: new Map<string, string[]>(), brew: new Set<string>(),
	env: {} as Record<string, string>, handlers: new Map<string, (...args: unknown[]) => unknown>(),
	exec: vi.fn(), spawn: vi.fn(), quit: vi.fn(), once: vi.fn(), trash: vi.fn(), write: vi.fn(),
}));
vi.mock("electron", () => ({ app: { get isPackaged() { return fake.packaged; }, getPath: () => fake.host === "win32" ? "C:\\profile" : "/profile", getVersion: () => "0.7.6", quit: fake.quit, once: fake.once }, shell: { trashItem: fake.trash } }));
vi.mock("node:fs/promises", () => ({
	access: async (path: string) => { if (!fake.files.has(path)) throw new Error("ENOENT"); },
	readFile: async (path: string) => { const value = fake.files.get(path); if (value === undefined) throw new Error("ENOENT"); return value; },
	realpath: async (path: string) => path,
}));
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => fake.exec(...args), spawn: (...args: unknown[]) => fake.spawn(...args) }));
vi.mock("node:os", () => ({ homedir: () => "/home/chris" }));
vi.mock("../../env", () => ({ userEnv: async () => fake.env }));
vi.mock("../../files", () => ({ writeText: fake.write }));
vi.mock("../../ipc", () => ({ handle: (channel: string, fn: (...args: unknown[]) => unknown) => fake.handlers.set(channel, fn) }));
vi.mock("../../services/executable", () => ({ resolveExecutable: async (path: string) => fake.brew.has(path) ? path : null }));
// Exercise both host path implementations on every CI runner, without changing target-platform paths.
vi.mock("node:path", async original => {
	const path = await original<typeof NodePath>();
	return { ...path, join: (...parts: string[]) => path[fake.host].join(...parts) };
});
import { registerInstallSwitch } from "./install-switch";
import { InstallOperation } from "../../services/install-operation";
let operation: InstallOperation;

const execPath = process.execPath;
const brew = "/opt/homebrew/bin/brew";
const target = "/Applications/visual-omp.app";
const plist = (version: string) => `<key>CFBundleShortVersionString</key><string>${version}</string>`;
function installApp(path: string, version = "0.7.6") {
	fake.files.set(path, "bundle");
	fake.files.set(`${path}/Contents/Info.plist`, plist(version));
	fake.files.set(`${path}/Contents/MacOS/visual-omp`, "executable");
}
const profileFile = (name: string) => fake.host === "win32" ? `C:\\profile\\${name}` : `/profile/${name}`;

describe.each(["posix", "win32"] as const)("install switch on a %s host", host => {

beforeEach(() => {
	vi.clearAllMocks();
	fake.host = host;
	operation = new InstallOperation(() => {});
	fake.method = "dmg"; fake.packaged = true; fake.files.clear(); fake.casks.clear(); fake.brew.clear(); fake.handlers.clear();
	fake.globalRoot = undefined;
	fake.env = { PATH: "/opt/homebrew/bin" };
	fake.brew.add(brew);
	process.execPath = `${target}/Contents/MacOS/visual-omp`;
	installApp(target);
	fake.exec.mockImplementation((_binary: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => callback(null, args[0] === "info" ? JSON.stringify({ casks: [{ version: "0.7.6" }] }) : "", ""));
	fake.spawn.mockReturnValue({ unref: vi.fn() });
	fake.write.mockResolvedValue(undefined); fake.trash.mockResolvedValue(undefined);
	registerInstallSwitch({ installInfo: async () => ({ method: fake.method, appPath: target, command: null, scoopGlobal: false }), caskApps: async path => fake.casks.get(path) ?? [], scoopGlobalPath: async () => fake.globalRoot, beginOperation: kind => operation.begin(kind), endOperation: kind => operation.end(kind) });
});
afterEach(() => { process.execPath = execPath; });
const invoke = (name: string, ...args: unknown[]) => fake.handlers.get(`updates:app:${name}`)!(...args);

describe("install switch availability", () => {
	it("offers a guide when Homebrew is absent without running a command", async () => {
		fake.brew.clear();
		expect(await invoke("switchInfo")).toMatchObject({ manager: "brew", available: false });
		expect(fake.exec).not.toHaveBeenCalled();
	});
	it.each(["brew", "scoop", "manual"] as const)("does not offer an automated switch for %s copies", async method => {
		fake.method = method;
		expect(await invoke("switchInfo")).toBeNull();
		await expect(invoke("switchStart")).rejects.toThrow("could not be found");
	});
	it("never switches development copies", async () => {
		fake.packaged = false;
		expect(await invoke("switchInfo")).toBeNull();
		await expect(invoke("switchComplete", false)).rejects.toThrow("Prepare");
	});
});

describe("macOS switch", () => {
	it("taps and refreshes before adopting the same version at the cask destination", async () => {
		const result = await invoke("switchStart") as AppInstallSwitchRun;
		expect(fake.exec.mock.calls.map(call => call[1])).toEqual([["tap", "decoy-dev/tap", "https://github.com/decoy-dev/visual-omp"], ["update"], ["info", "--json=v2", "--cask", "decoy-dev/tap/visual-omp"]]);
		expect(result.command).toContain("--adopt");
		expect(result.canTrash).toBe(false);
		expect(fake.quit).not.toHaveBeenCalled();
	});
	it("refuses a different destination version without replacing files", async () => {
		installApp(target, "0.7.5");
		await expect(invoke("switchStart")).rejects.toThrow("Update that copy first");
		expect(fake.files.get(`${target}/Contents/Info.plist`)).toBe(plist("0.7.5"));
		expect(operation.current).toBeNull();
		expect(fake.quit).not.toHaveBeenCalled();
	});
	it("refuses restart until Homebrew registers the target, then reopens it from disk", async () => {
		await invoke("switchStart");
		await invoke("switchSettled");
		await expect(invoke("switchComplete", false)).rejects.toThrow("not registered");
		fake.casks.set(brew, [target]);
		await invoke("switchComplete", false);
		expect(fake.write).toHaveBeenCalledWith(profileFile("update-pending.json"), expect.stringContaining('"operation":"switch"'));
		expect(fake.quit).toHaveBeenCalledOnce();
		fake.once.mock.calls.find(call => call[0] === "will-quit")![1]();
		expect(fake.spawn).toHaveBeenCalledWith("/bin/sh", ["-c", expect.stringContaining("/usr/bin/open"), target, String(process.pid)], { detached: true, stdio: "ignore" });
	});
	it("keeps an old copy elsewhere unless moving it to the Trash is explicitly selected", async () => {
		const old = "/Users/chris/Desktop/visual-omp.app";
		process.execPath = `${old}/Contents/MacOS/visual-omp`; installApp(old);
		const run = await invoke("switchStart") as AppInstallSwitchRun;
		expect(run).toMatchObject({ target, canTrash: true });
		expect(run.command).toContain("--adopt");
		await invoke("switchSettled");
		fake.casks.set(brew, [target]);
		await invoke("switchComplete", false);
		expect(fake.trash).not.toHaveBeenCalled();
		operation.end("switch");
		await invoke("switchComplete", true);
		expect(fake.trash).toHaveBeenCalledWith(old);
	});
	it("reuses a cask copy in any discovered Homebrew prefix without making a third copy", async () => {
		fake.env.PATH = "/opt/homebrew/bin:/custom/homebrew/bin";
		fake.brew.add("/custom/homebrew/bin/brew");
		const existing = "/Users/chris/Applications/visual-omp.app";
		fake.casks.set("/custom/homebrew/bin/brew", [existing]); installApp(existing, "0.7.4");
		expect(await invoke("switchInfo")).toMatchObject({ existing: true, target: existing });
		expect(await invoke("switchStart")).toMatchObject({ existing: true, command: null, target: existing, version: "0.7.4" });
		expect(fake.exec).not.toHaveBeenCalled();
		await invoke("switchComplete", false);
		expect(fake.quit).toHaveBeenCalledOnce();
	});
	it("checks the destination version independently of the running copy's folder", async () => {
		const old = "/Users/chris/Desktop/visual-omp.app";
		process.execPath = `${old}/Contents/MacOS/visual-omp`; installApp(old);
		installApp(target, "0.7.5");
		await expect(invoke("switchStart")).rejects.toThrow("Update that copy first");
		expect(fake.files.get(`${target}/Contents/Info.plist`)).toBe(plist("0.7.5"));
	});
	it("installs into an empty destination without replacing the running bundle elsewhere", async () => {
		const old = "/Users/chris/Desktop/visual-omp.app";
		process.execPath = `${old}/Contents/MacOS/visual-omp`; installApp(old);
		fake.files.delete(target); fake.files.delete(`${target}/Contents/Info.plist`); fake.files.delete(`${target}/Contents/MacOS/visual-omp`);
		const run = await invoke("switchStart") as AppInstallSwitchRun;
		expect(run).toMatchObject({ target, canTrash: true });
		expect(run.command).toContain("--adopt");
		expect(fake.files.get(`${old}/Contents/Info.plist`)).toBe(plist("0.7.6"));
	});
	it.each(["update", "reinstall", "switch"] as const)("refuses a switch while %s owns installation", async kind => {
		operation.begin(kind);
		await expect(invoke("switchStart")).rejects.toThrow("in progress");
		expect(fake.exec).not.toHaveBeenCalled();
	});
	it("honors Homebrew's configured app directory", async () => {
		fake.env.HOMEBREW_CASK_OPTS = '--appdir="/Users/chris/My Apps"';
		const run = await invoke("switchStart") as AppInstallSwitchRun;
		expect(run.target).toBe("/Users/chris/My Apps/visual-omp.app");
		expect(run.command).toContain("'--appdir=/Users/chris/My Apps'");
	});
	it("does not quit or trash anything when verification or preparation fails", async () => {
		fake.exec.mockImplementation((_binary: string, _args: string[], _options: unknown, callback: (error: Error, stdout: string, stderr: string) => void) => callback(new Error("offline"), "", "Network unavailable"));
		await expect(invoke("switchStart")).rejects.toThrow("Network unavailable");
		await expect(invoke("switchComplete", true)).rejects.toThrow("Prepare");
		expect(fake.quit).not.toHaveBeenCalled(); expect(fake.trash).not.toHaveBeenCalled();
	});
});

describe("Windows switch", () => {
	const root = "C:\\Users\\chris\\scoop";
	const original = "C:\\Users\\chris\\Apps\\visual-omp\\visual-omp.exe";
	const scoop = `${root}\\shims\\scoop.ps1`;
	function windows() {
		fake.method = "nsis";
		process.execPath = original;
		fake.env = { SCOOP: root, USERPROFILE: "C:\\Users\\chris", ProgramData: "C:\\ProgramData" };
		fake.files.set(scoop, "script");
		fake.files.set("C:\\Users\\chris\\Apps\\visual-omp\\Uninstall visual-omp.exe", "uninstaller");
	}
	it("offers Scoop setup when no manager exists", async () => {
		windows(); fake.files.delete(scoop);
		expect(await invoke("switchInfo")).toMatchObject({ manager: "scoop", available: false });
		expect(fake.exec).not.toHaveBeenCalled();
	});
	it("checks later user and global roots before proposing a fresh installation", async () => {
		windows();
		fake.env.SCOOP_GLOBAL = "D:\\Global scoop";
		fake.files.set("D:\\Global scoop\\apps\\visual-omp", "directory");
		expect(await invoke("switchInfo")).toMatchObject({
			manager: "scoop", available: true, existing: true,
			target: "D:\\Global scoop\\apps\\visual-omp\\current\\visual-omp.exe",
		});
		expect(await invoke("switchStart")).toMatchObject({ existing: true, command: null, canTrash: false });
		expect(operation.current).toBeNull();
		expect(fake.quit).not.toHaveBeenCalled();
	});
	it("reuses a copy found only through Scoop's configured global_path and includes that root after exit", async () => {
		windows();
		fake.globalRoot = "E:\\Configured global scoop";
		fake.files.set("E:\\Configured global scoop\\apps\\visual-omp", "directory");
		const target = "E:\\Configured global scoop\\apps\\visual-omp\\current\\visual-omp.exe";
		expect(await invoke("switchInfo")).toMatchObject({ manager: "scoop", available: true, existing: true, target });
		expect(await invoke("switchStart")).toMatchObject({ existing: true, target, command: null });
		// Completion must read the same shared config reader again, rather than keeping a stale probe.
		fake.globalRoot = "F:\\New configured global scoop";
		await invoke("switchComplete", false);
		expect(fake.write).toHaveBeenCalledWith(profileFile("scoop-switch.ps1"), expect.stringContaining("'F:\\New configured global scoop'"));
		expect(fake.write).toHaveBeenCalledWith(profileFile("scoop-switch.ps1"), expect.stringContaining("$config.global_path"));
		expect(fake.exec).not.toHaveBeenCalled();
	});
	it("writes the exact post-exit script before quitting and runs a short encoded file command", async () => {
		windows();
		await invoke("switchStart");
		await invoke("switchComplete", false);
		expect(operation.current).toBe("switch");
		expect(fake.write).toHaveBeenCalledWith(profileFile("scoop-switch.ps1"), expect.stringContaining("param([switch]$DryLaunch)"));
		expect(fake.quit).toHaveBeenCalledOnce();
		expect(fake.spawn).not.toHaveBeenCalled();
		fake.once.mock.calls.find(call => call[0] === "will-quit")![1]();
		const [binary, args, options] = fake.spawn.mock.calls[0]!;
		expect(binary).toMatch(/System32\\cmd\.exe$/);
		expect(options).toMatchObject({ detached: true, windowsVerbatimArguments: true });
		const encoded = args[2].split("-EncodedCommand ")[1];
		expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(`& '${profileFile("scoop-switch.ps1")}'`);
	});
	it.each(["update", "reinstall", "switch"] as const)("refuses preparing or completing while %s owns installation", async kind => {
		windows();
		await invoke("switchStart");
		operation.begin(kind);
		await expect(invoke("switchStart")).rejects.toThrow("in progress");
		await expect(invoke("switchComplete", false)).rejects.toThrow("in progress");
		expect(fake.write).not.toHaveBeenCalled();
		expect(fake.quit).not.toHaveBeenCalled();
	});
	it("keeps the installer running if its uninstaller or script cannot be prepared", async () => {
		windows();
		fake.files.delete("C:\\Users\\chris\\Apps\\visual-omp\\Uninstall visual-omp.exe");
		await expect(invoke("switchStart")).rejects.toThrow("uninstaller is missing");
		windows();
		await invoke("switchStart");
		fake.write.mockRejectedValueOnce(new Error("disk full"));
		await expect(invoke("switchComplete", false)).rejects.toThrow("disk full");
		expect(operation.current).toBeNull();
		expect(fake.quit).not.toHaveBeenCalled();
	});
});
});
