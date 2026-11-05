import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectLibreOffice, officeEnvironment, officeProfile, officeRuntime } from "./preview-office-runtime";
import { resolveExecutable } from "./executable";
import { spawn, execFile } from "node:child_process";

vi.mock("./preview-office.worker?nodeWorker", () => ({ default: vi.fn() }));
vi.mock("./executable", () => ({ resolveExecutable: vi.fn() }));
vi.mock("../env", () => ({ userEnv: async () => ({ PATH: "/login/bin", HOME: "/home/person", API_KEY: "secret", NO_PROXY: "*", https_proxy: "https://existing.test" }) }));
vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe("LibreOffice discovery and network barriers", () => {
	it("prefers the login-shell PATH and checks platform fallback paths", async () => {
		vi.mocked(resolveExecutable).mockImplementation(async command => command === "soffice" ? "/login/bin/soffice" : null);
		expect(await detectLibreOffice({ PATH: "/login/bin" }, "darwin")).toBe("/login/bin/soffice");
		vi.mocked(resolveExecutable).mockImplementation(async command => command === "/Applications/LibreOffice.app/Contents/MacOS/soffice" ? command : null);
		expect(await detectLibreOffice({}, "darwin")).toBe("/Applications/LibreOffice.app/Contents/MacOS/soffice");
		vi.mocked(resolveExecutable).mockImplementation(async command => command.endsWith("soffice.exe") ? command : null);
		expect(await detectLibreOffice({ ProgramFiles: "D:\\Apps" }, "win32")).toBe("D:\\Apps\\LibreOffice\\program\\soffice.exe");
		vi.mocked(resolveExecutable).mockResolvedValue(null);
		expect(await detectLibreOffice({}, "linux")).toBeNull();
	});
	it("seeds the highest macro level, disables active content and blocks untrusted links", () => {
		const profile = officeProfile(47832);
		for (const key of ["MacroSecurityLevel", "DisableMacrosExecution", "DisableActiveContent", "BlockUntrustedRefererLinks", "ooInetProxyType", "ooInetNoProxy"]) expect(profile).toContain(key);
		expect(profile).toContain('<value>3</value>');
		expect(profile).toContain('<value>47832</value>');
		expect(profile).toContain('<value>127.0.0.1</value>');
	});
	it("drops secrets and inherited proxy bypasses from the minimal child environment", () => {
		const env = officeEnvironment({ PATH: "/bin", HOME: "/home/person", TOKEN: "secret", NODE_OPTIONS: "--inspect", NO_PROXY: "*", HTTPS_PROXY: "https://outside.test" }, 40001);
		expect(env.TOKEN).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined();
		expect(env.no_proxy).toBe(""); expect(env.NO_PROXY).toBe("");
		expect(env.https_proxy).toBe("http://127.0.0.1:40001"); expect(env.HTTPS_PROXY).toBe(env.https_proxy);
	});
	it("uses the private profile, headless flags, no shell and process-tree kill on abort", async () => {
		const folder = await mkdtemp(join(tmpdir(), "vomp-office-runtime-"));
		try {
			await mkdir(join(folder, "profile", "user"), { recursive: true });
			const child = Object.assign(new EventEmitter(), { pid: 123456, kill: vi.fn() });
			vi.mocked(spawn).mockReturnValue(child as never);
			vi.mocked(resolveExecutable).mockResolvedValue("/Windows/System32/taskkill.exe");
			vi.mocked(execFile).mockImplementation((...args: unknown[]) => { queueMicrotask(() => { (args.at(-1) as (error: Error | null) => void)(null); }); return child as never; });
			const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => { if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" }); return true; });
			const abort = new AbortController();
			const result = officeRuntime.convert("/scratch/soffice", join(folder, "input.pptx"), folder, join(folder, "profile"), abort.signal);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			const [exe, args, options] = vi.mocked(spawn).mock.calls.at(-1)!;
			expect(exe).toBe("/scratch/soffice");
			expect(args).toEqual(expect.arrayContaining(["--headless", "--norestore", "--nolockcheck", "--nodefault", "--convert-to", "pdf"]));
			expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: "ignore" });
			expect(await readFile(join(folder, "profile", "user", "registrymodifications.xcu"), "utf8")).toContain("DisableMacrosExecution");
			abort.abort(); expect(await result).toBe(false);
			if (process.platform !== "win32") expect(kill).toHaveBeenCalledWith(-123456, "SIGKILL");
		} finally { await rm(folder, { recursive: true, force: true }); }
	});
});
