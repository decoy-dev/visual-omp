import type * as NodePath from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn(), unref: vi.fn(), readFile: vi.fn(), resolveExecutable: vi.fn(), application: vi.fn(), command: "", desktop: "" }));
vi.mock("node:child_process", () => ({ execFile: deps.execFile, spawn: deps.spawn }));
vi.mock("node:fs/promises", () => ({ readFile: deps.readFile }));
vi.mock("electron", () => ({ app: { getApplicationInfoForProtocol: deps.application } }));
vi.mock("./executable", () => ({ resolveExecutable: deps.resolveExecutable }));
// A Windows host must not change the POSIX paths used by the Linux and macOS branches.
vi.mock("node:path", async original => {
	const path = await original<typeof NodePath>();
	return { ...path, join: path.win32.join, basename: path.win32.basename, isAbsolute: path.win32.isAbsolute };
});
import { defaultBrowserLaunch, launchBrowserCommand, runBrowserCommand } from "./default-browser";

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("XDG_DATA_HOME", "/home/example/.local/share");
	vi.stubEnv("XDG_DATA_DIRS", "/usr/share");
	vi.stubEnv("ProgramFiles", "C:\\Program Files");
	deps.application.mockResolvedValue({ name: "Web browser", path: "/Applications/Web browser.app" });
	deps.resolveExecutable.mockImplementation(async (name: string) => `/tools/${name}`);
	deps.command = '"C:\\Program Files\\Web browser\\browser.exe" --single-argument "%1"';
	deps.desktop = '[Desktop Entry]\nType=Application\nName=Web browser\nExec="/opt/Web browser/browser" --new-window %u\n';
	deps.readFile.mockImplementation(async () => deps.desktop);
	deps.execFile.mockImplementation((executable: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
		const output = executable.endsWith("reg.exe") ? args.includes("ProgId") ? "    ProgId    REG_SZ    BrowserHTML\r\n" : `    (Default)    REG_SZ    ${deps.command}\r\n`
			: executable.endsWith("xdg-settings") ? "web-browser.desktop\n" : "";
		callback(null, output, "");
	});
	deps.spawn.mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), { unref: deps.unref });
		queueMicrotask(() => child.emit("spawn"));
		return child;
	});
});
afterEach(() => vi.unstubAllEnvs());

describe("default HTTPS browser selection", () => {
	it("uses Launch Services' HTTPS application explicitly on macOS", async () => {
		const path = '/tmp/a #; "report".html';
		expect(await defaultBrowserLaunch(path, "darwin")).toEqual({ executable: "/usr/bin/open", args: ["-a", "/Applications/Web browser.app", "--", path] });
		expect(deps.application).toHaveBeenCalledWith("https://");
		expect(deps.execFile).not.toHaveBeenCalled();
	});
	it("reports no browser when Launch Services cannot resolve one", async () => {
		deps.application.mockRejectedValue(new Error("No HTTPS application"));
		expect(await defaultBrowserLaunch("/tmp/page.html", "darwin")).toBeNull();
	});
	it("uses the Windows HTTPS ProgId command and passes the local path as one literal argument", async () => {
		const path = 'C:\\reports\\a & echo dangerous; "name".html';
		expect(await defaultBrowserLaunch(path, "win32")).toEqual({ executable: "C:\\Program Files\\Web browser\\browser.exe", args: ["--single-argument", path] });
		expect(deps.execFile.mock.calls[0]?.[1]).toEqual(["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"]);
		expect(deps.execFile.mock.calls[1]?.[1]).toEqual(["query", "HKCR\\BrowserHTML\\shell\\open\\command", "/ve"]);
	});
	it("expands a registered Windows executable without expanding the file argument", async () => {
		deps.command = '"%ProgramFiles%\\Web browser\\browser.exe" "%L"';
		const path = "C:\\reports\\%ProgramFiles%.html";
		expect(await defaultBrowserLaunch(path, "win32")).toEqual({ executable: "C:\\Program Files\\Web browser\\browser.exe", args: [path] });
	});
	it.each([
		'"C:\\Windows\\System32\\cmd.exe" /c "%1"',
		'"C:\\browser.exe" --url="%1"',
		'"C:\\browser.exe"',
		'"C:\\browser.exe %1',
	])("declines an unsupported Windows command: %s", async command => {
		deps.command = command;
		expect(await defaultBrowserLaunch("C:\\reports\\page.html", "win32")).toBeNull();
	});
	it("reads Linux's default browser desktop entry and substitutes a URI field safely", async () => {
		const path = '/tmp/a #; "report".html';
		expect(await defaultBrowserLaunch(path, "linux")).toEqual({ executable: "/opt/Web browser/browser", args: ["--new-window", 'file:///tmp/a%20%23;%20%22report%22.html'] });
		expect(deps.execFile.mock.calls[0]?.[1]).toEqual(["get", "default-web-browser"]);
		expect(deps.readFile).toHaveBeenCalledWith("/home/example/.local/share/applications/web-browser.desktop", "utf8");
	});
	it("uses a Linux file field as one argument and ignores desktop action commands", async () => {
		deps.desktop = '[Desktop Entry]\nExec=browser %f\n[Desktop Action private]\nExec=another-browser %u\n';
		const path = "/tmp/a;touch bad.html";
		expect(await defaultBrowserLaunch(path, "linux")).toEqual({ executable: "/tools/browser", args: [path] });
	});
	it("searches the next Linux data directory when the user has no desktop entry", async () => {
		deps.readFile.mockRejectedValueOnce(new Error("ENOENT"));
		expect(await defaultBrowserLaunch("/tmp/page.html", "linux")).not.toBeNull();
		expect(deps.readFile).toHaveBeenCalledWith("/usr/share/applications/web-browser.desktop", "utf8");
	});
	it.each(['[Desktop Entry]\nExec=sh -c "browser %u"', '[Desktop Entry]\nExec=env sh -c %u', '[Desktop Entry]\nExec=browser --url=%u'])
	("declines Linux command templates that could reinterpret the file path: %s", async desktop => {
		deps.desktop = desktop;
		expect(await defaultBrowserLaunch("/tmp/page.html", "linux")).toBeNull();
	});
	it("reports missing Linux browser discovery for the warned association fallback", async () => {
		deps.resolveExecutable.mockResolvedValue(null);
		expect(await defaultBrowserLaunch("/tmp/page.html", "linux")).toBeNull();
	});
	it("launches with a direct argument array and propagates launch failures", async () => {
		const launch = { executable: "/opt/browser", args: ["/tmp/a; touch bad.html"] };
		await runBrowserCommand(launch);
		expect(deps.execFile).toHaveBeenCalledWith(launch.executable, launch.args, expect.objectContaining({ windowsHide: true, timeout: 15_000 }), expect.any(Function));
		expect(deps.execFile.mock.calls[0]?.[2]).not.toHaveProperty("shell");
		deps.execFile.mockImplementation((_executable: string, _args: string[], _options: unknown, callback: (error: Error) => void) => callback(new Error("Launch failed")));
		await expect(runBrowserCommand(launch)).rejects.toThrow("Launch failed");
	});
	it("detaches a selected browser without waiting for it to exit or killing it after a timeout", async () => {
		const launch = { executable: "/opt/browser", args: ["/tmp/a; touch bad.html"] };
		await launchBrowserCommand(launch);
		expect(deps.spawn).toHaveBeenCalledWith(launch.executable, launch.args, { detached: true, stdio: "ignore", windowsHide: true });
		expect(deps.unref).toHaveBeenCalledOnce();
		expect(deps.execFile).not.toHaveBeenCalled();
	});
});
