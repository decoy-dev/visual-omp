import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { OMP_DISCOVERY_ISOLATION } from "../../src/main/omp/discovery-isolation";
import {
	CASE_LIMITS, caseConfig, caseEnvironment, caseProcessArgs, constructWindowsCases,
	driveAlias, evidenceExtensionSource, parseCaseArgs, shellQuote,
} from "./bash-visualization-windows-cases";

const args = ["--omp", "C:\\private engines\\omp.exe", "--output", "D:\\owned evidence\\new case run"];

describe("Windows native case CLI construction", () => {
	it("requires explicit absolute executable and exclusive output directory arguments", () => {
		expect(parseCaseArgs(args)).toEqual({ omp: args[1], output: args[3] });
		expect(parseCaseArgs(["--output", "D:/owned/new run", "--omp", "C:/engines/omp.exe"])).toEqual({ omp: "C:\\engines\\omp.exe", output: "D:\\owned\\new run" });
		for (const invalid of [
			[], ["--omp", args[1]!], [...args, "--extra", "value"], [...args, "--output", "D:\\again"],
			["--omp", "omp.exe", "--output", args[3]!], ["--omp", "C:omp.exe", "--output", args[3]!],
			["--omp", "\\omp.exe", "--output", args[3]!], ["--omp", args[1]!, "--output", "relative"],
			["--omp", args[1]!, "--output", "D:\\"], ["--omp", args[1]!, "--output", "\\\\server\\share\\case"],
			["--omp", "C:\\engines\\omp.cmd", "--output", args[3]!], ["--omp", "C:\\bad\0.exe", "--output", args[3]!],
			["--omp", "--output"], ["--omp=C:\\omp.exe", "--output", args[3]!],
		]) expect(() => parseCaseArgs(invalid)).toThrow();
	});

	it("derives aliases from the fixture drive and preserves quoted spaces and apostrophes", () => {
		expect(driveAlias("Z:\\owned evidence\\scratch fixture\\dir one")).toBe("/z/owned evidence/scratch fixture/dir one");
		expect(driveAlias("Z:\\owned evidence\\scratch fixture\\dir one", true)).toBe("/mnt/z/owned evidence/scratch fixture/dir one");
		expect(shellQuote("Z:/scratch/it's dir")).toBe("'Z:/scratch/it'\\''s dir'");
		expect(() => driveAlias("\\\\server\\share\\folder")).toThrow();
	});

	it("uses one no-tools RPC launch with only the private extension enabled", () => {
		const extension = "D:\\private scratch\\evidence.mjs";
		expect(caseProcessArgs(extension)).toEqual([
			"--mode", "rpc", "--no-session", "--no-extensions", "--no-context-files", "--no-rules", "--no-skills", "--no-lsp", "--no-title", "--no-tools",
			"--model", "fixture/windows-cases", "--thinking", "off", "-e", extension,
		]);
		expect(CASE_LIMITS).toMatchObject({ startupMs: 15000, captureMs: 15000, requestMs: 2000, sampleMs: 100, outputBytes: 2 * 1024 ** 2, traceBytes: 16 * 1024 ** 2, jobRssBytes: 512 * 1024 ** 2, monitorRssBytes: 160 * 1024 ** 2 });
	});
});

describe("Windows engine matrix safety", () => {
	const root = "Z:\\owned evidence\\scratch fixture";
	const system32 = "Q:\\Windows\\System32";
	const cases = constructWindowsCases(root, system32);

	it("covers all seven groups with separate bounded cases", () => {
		expect(cases).toHaveLength(16);
		expect(new Set(cases.map(test => test.id)).size).toBe(16);
		expect([...new Set(cases.map(test => test.group))].sort()).toEqual([
			"cmd-find-quoting", "engine-cd", "gnu-and-other-cmd-controls", "hoisted-separators", "msys-consumers", "pathext-rebind", "same-shell-path-rebind",
		]);
		expect(cases.every(test => test.cwd.startsWith(root) && test.expected.length > 0 && test.status === 0)).toBe(true);
		expect(cases.filter(test => test.id.startsWith("leading-")).map(test => test.id)).toEqual(["leading-and-engine-control", "leading-semicolon-engine-control"]);
		expect(cases.find(test => test.id === "nonleading-msys-cd")!.script).toContain("true && cd '/z/owned evidence/scratch fixture/dir one'");
		expect(cases.find(test => test.id === "flagged-mounted-cd")!.script).toContain("cd -P '/mnt/z/owned evidence/scratch fixture/dir one'");
		expect(cases.find(test => test.id === "msys-tests-and-redirects")!.script).toContain('read -r line < "$d/a b.txt"');
		expect(cases.find(test => test.id === "msys-program-alias")!.script).toContain("'/mnt/q/Windows/System32/where.exe' '/?'");
	});

	it("guards cmd FIND with the exact executable and System32-only PATH before dispatch", () => {
		for (const test of cases.filter(test => test.group === "cmd-find-quoting")) {
			expect(test.script).toMatch(/^\[ -f 'Q:\/Windows\/System32\/find\.exe' \] \|\| exit 91; PATH='Q:\/Windows\/System32'; /);
			expect(test.script.indexOf("PATH=")).toBeLessThan(test.script.indexOf("find /"));
		}
		expect(cases.find(test => test.id === "cmd-find-empty")!.script).toContain('find /c /v "" "a b.txt"');
		expect(cases.find(test => test.id === "cmd-find-slash-operand")!.script).toContain('find /i "/API"');
		const gnu = cases.find(test => test.id === "gnu-find-bounded")!.script;
		expect(gnu).toContain("find '/z/owned evidence/scratch fixture/dir one' -maxdepth 1 -name '*.txt'");
		expect(gnu).not.toContain("find /c");
	});

	it("collects help only for identity utilities and rebinds helpers within each single Shell script", () => {
		const whoami = cases.filter(test => test.script.includes("whoami"));
		expect(whoami).toHaveLength(1);
		expect(whoami[0]!.script).toContain("whoami '/?' > \"whoami help.txt\"");
		const where = cases.find(test => test.id === "msys-program-alias")!.script;
		expect(where).toContain("where.exe' '/?' >");
		// A bare /? is a glob and expanded to /T in the failed recorded cases.
		expect(whoami[0]!.script).not.toContain("whoami /?");
		expect(where).not.toContain("where.exe' /?");
		const path = cases.find(test => test.id === "same-shell-path-rebind")!.script;
		expect(path).toContain("PATH='Z:/owned evidence/scratch fixture/bin-a;Q:/Windows/System32'; vomp_case_tool;");
		expect(path).toContain("PATH='Z:/owned evidence/scratch fixture/bin-b;Q:/Windows/System32';");
		expect(path).toContain("${#BASH_CMDS[@]}");
		const append = cases.find(test => test.id === "same-shell-path-append-unset")!.script;
		expect(append).toContain("PATH+="); expect(append).toContain("unset PATH;");
		const pathext = cases.find(test => test.id === "pathext-order-rebind")!.script;
		expect(pathext.indexOf("PATHEXT='.BAT;.CMD'")).toBeLessThan(pathext.indexOf("PATHEXT='.CMD;.BAT'"));
		expect(pathext.match(/vomp_case_ext/g)).toHaveLength(2);
	});
});

describe("Windows fixture isolation", () => {
	it("reuses the production environment allowlist and places state beneath its private root", () => {
		const root = join(process.cwd(), "private fixture root");
		const env = caseEnvironment({ Path: "system-only", SystemRoot: "C:\\Windows", PATHEXT: ".EXE;.CMD", HOME: "owner-home", PI_CODING_AGENT_DIR: "owner-agent", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret", NODE_OPTIONS: "preload", BUN_OPTIONS: "preload", HTTP_PROXY: "private", OMP_CONFIG: "owner-config" }, root);
		expect(env.PATH).toBe("system-only"); expect(env.SYSTEMROOT).toBe("C:\\Windows");
		for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "BUN_OPTIONS", "HTTP_PROXY", "OMP_CONFIG"]) expect(env).not.toHaveProperty(key);
		for (const key of ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP"]) expect(env[key]).toContain(root);
		expect(caseConfig()).toMatchObject({ ...OMP_DISCOVERY_ISOLATION, update: { auto: false }, collab: { autoStart: "off" }, skills: { enabled: false }, lsp: { enabled: false }, memory: { backend: "off" }, modelRoles: { default: "fixture/windows-cases", smol: "fixture/windows-cases", tiny: "fixture/windows-cases" } });
	});

	it("serializes the existing extension as a callable module without invoking native capture during registration", async () => {
		expect(evidenceExtensionSource).toMatch(/^export default (?:async )?function/);
		const subscriptions: { name: string; callback: () => Promise<void> }[] = [];
		// No module imports or native operations execute while loading and registering the serialized extension.
		const extension = runInNewContext("(" + evidenceExtensionSource.slice("export default ".length).trim().replace(/;$/, "") + ")", { process: { env: {} } }) as (pi: { on(name: string, callback: () => Promise<void>): void }) => void;
		extension({ on(name, callback) { subscriptions.push({ name, callback }); } });
		expect(subscriptions.map(value => value.name)).toEqual(["session_start"]);
		await expect(subscriptions[0]!.callback()).resolves.toBeUndefined();
		expect(evidenceExtensionSource).toContain("Capture output byte limit; retained prefix only");
		expect(evidenceExtensionSource).toContain("Capture trace byte limit");
	});
});

describe("capture UTF-8 response bounds", () => {
	const start = evidenceExtensionSource.indexOf("const trace = new natives.RunTrace");
	const end = evidenceExtensionSource.indexOf("} else if (request.op ===", start);
	const capture = (chunk: Buffer) => {
		expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
		// Execute the extension's actual capture block with unit-only native stand-ins.
		return runInNewContext("(async () => { let data; " + evidenceExtensionSource.slice(start, end) + "; return data; })()", {
			Buffer, request: { script: "fixture", cwd: "C:\\scratch", timeoutMs: 1000, outputBytes: 1 }, preferences: {},
			natives: {
				RunTrace: class { snapshot() { return JSON.stringify({ script: "fixture", history: [] }); } present() { return JSON.stringify({ rows: [] }); } },
				Shell: class { async run(_options: unknown, callback: (error: null, chunk: Buffer) => void) { callback(null, chunk); return { exitCode: 0 }; } },
			},
		}) as Promise<{ output: string }>;
	};
	it.each([
		["invalid byte", Buffer.from([0xff])],
		["truncated multibyte scalar", Buffer.from("é")],
	] as const)("refuses a decoded %s that exceeds the wire byte allowance", async (_name, chunk) => {
		await expect(capture(chunk)).rejects.toThrow("Decoded capture output byte limit");
	});
	it("retains valid output within the same wire byte allowance", async () => {
		expect((await capture(Buffer.from("a"))).output).toBe("a");
	});
});
