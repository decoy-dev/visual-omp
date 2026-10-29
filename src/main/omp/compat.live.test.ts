import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { COLLAB_PROTO } from "../../renderer/src/collab/wire";
import { OMP_BUILTIN_COMMANDS } from "../services/omp-builtin-commands";
import { parseConfigList, parseModels } from "../services/omp-config";
import { parseOmpUpdateCheck } from "../services/updates";
import { compareSemver } from "@shared/semver";

// Keep Electron and the owner's profile outside this process. rpcRequest itself is the app's transport.
const isolated = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv, bin: "" }));
vi.mock("../env", () => ({ userEnv: async () => isolated.env }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ ompPath: isolated.bin }) }));
import { MIN_OMP_VERSION } from "./locate";
import { rpcRequest } from "./rpc";

// RPC intentionally omits terminal-only builtins. This is the 18.14 RPC subset of the app's catalog.
const RPC_BUILTINS_1814 = [
	"security", "model", "switch", "fast", "slow", "skillful", "extended-context", "computer", "ratchet", "prewalk",
	"modelpreset", "effort", "advisor", "export", "trace", "dump", "share", "browser", "todo", "session", "jobs",
	"usage", "stats", "changelog", "tools", "context", "mcp", "ssh", "fresh", "compact", "shake", "handoff", "pin",
	"retry", "memory", "rename", "move", "wt", "add-dir", "remove-dir", "dirs", "marketplace", "plugins", "reload-plugins",
	"force", "forget-approvals",
];
const CommandsSchema = z.object({ commands: z.array(z.object({ name: z.string(), description: z.string(), source: z.string() })) });
const evidence: Record<string, unknown> = {};
let root = "";
let version: string | undefined;

function cli(args: string[], timeout = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
	const { promise, resolve: resolveResult, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
	execFile(isolated.bin, args, { cwd: root, env: isolated.env, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
		if (error && typeof error.code !== "number") { reject(error); return; }
		resolveResult({ code: (error?.code as number | undefined) ?? 0, stdout, stderr });
	});
	return promise;
}

function check(name: string, run: () => Promise<unknown>): void {
	it(name, async () => {
		try { evidence[name] = { status: "passed", details: await run() }; }
		catch (error) {
			evidence[name] = { status: "failed", error: error instanceof Error ? error.message : String(error) };
			throw error;
		}
	}, 60_000);
}

describe.skipIf(!process.env.OMP_BIN)("live omp compatibility (no sign-in or model requests)", () => {
	beforeAll(async () => {
		isolated.bin = resolve(process.env.OMP_BIN!);
		root = await mkdtemp(join(tmpdir(), "vomp-compat-"));
		const home = join(root, "home");
		const agent = join(root, "agent");
		await Promise.all([mkdir(home), mkdir(agent)]);
		// Explicit allowlist: never inherit API keys, broker credentials, plugins or the owner's config.
		isolated.env = {
			PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
			HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
			TMPDIR: root, TMP: root, TEMP: root, PI_CODING_AGENT_DIR: agent, PI_TUI_NATIVE: "0", NO_COLOR: "1",
		};
		await writeFile(join(agent, "config.yml"), "startup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: off\nrecap:\n  enabled: false\ncomposer:\n  predictions: false\ngit:\n  enabled: false\n");
	});

	afterAll(async () => {
		if (process.env.OMP_COMPAT_REPORT) {
			const target = resolve(process.env.OMP_COMPAT_REPORT);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, JSON.stringify({ version, minimumVersion: MIN_OMP_VERSION, checks: evidence }, null, 2));
		}
		if (root) await rm(root, { recursive: true, force: true });
	});

	check("version meets the app minimum", async () => {
		const result = await cli(["--version"]);
		expect(result.code, result.stderr).toBe(0);
		version = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(result.stdout)?.[1];
		expect(version, result.stdout).toBeDefined();
		expect(compareSemver(version!, MIN_OMP_VERSION), `omp ${version} is below required ${MIN_OMP_VERSION}`).toBeGreaterThanOrEqual(0);
		if (process.env.OMP_EXPECTED_VERSION) expect(version).toBe(process.env.OMP_EXPECTED_VERSION);
		return { version, minimum: MIN_OMP_VERSION };
	});

	check("settings parse through the app settings parser", async () => {
		const result = await cli(["config", "list", "--json"]);
		expect(result.code, result.stderr).toBe(0);
		const settings = parseConfigList(JSON.parse(result.stdout));
		expect(settings.size).toBeGreaterThan(0);
		for (const key of ["tools.approvalMode", "modelRoles", "collab.autoStart"]) expect(settings.has(key), key).toBe(true);
		return { settings: settings.size };
	});

	check("models parse through the app model parser", async () => {
		const result = await cli(["models", "--json", "--no-extensions"]);
		expect(result.code, result.stderr).toBe(0);
		const json = JSON.parse(result.stdout);
		const models = parseModels(json);
		// A credential-free Linux profile can legitimately have no available models.
		expect(Array.isArray(json.models)).toBe(true);
		expect(models.length).toBe(json.models.length);
		return { models: models.length, selectors: models.map(model => model.selector) };
	});

	check("RPC builtin commands match the app catalog and the 18.14 RPC subset", async () => {
		const frames: unknown[] = [];
		const data = await rpcRequest(root, "get_available_commands", {
			flags: ["--no-session", "--no-lsp", "--no-title", "--no-rules", "--no-extensions", "--no-skills", "--model", "anthropic/claude-sonnet-4-5"],
			timeoutMs: 45_000,
			messages: { timeout: "RPC command listing timed out", exited: "RPC exited before listing commands", failed: "RPC command listing failed" },
			onMessage: message => frames.push(message),
		});
		const builtin = CommandsSchema.parse(data).commands.filter(command => command.source === "builtin").map(command => command.name).sort();
		const appNames = new Set(OMP_BUILTIN_COMMANDS.map(command => command.name));
		const baseline = new Set(RPC_BUILTINS_1814);
		const added = builtin.filter(name => !baseline.has(name));
		const removed = RPC_BUILTINS_1814.filter(name => !builtin.includes(name));
		const missingFromApp = builtin.filter(name => !appNames.has(name));
		evidence.commandDiff = { added, removed, missingFromApp, rpcBuiltins: builtin, terminalOnly: [...appNames].filter(name => !baseline.has(name)) };
		const ready = frames.find(frame => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "ready");
		expect(ready, "The app expects RPC protocol 1 JSON lines").toMatchObject({ protocolVersion: 1 });
		expect({ added, removed, missingFromApp }, "Review new, removed or uncatalogued RPC commands").toEqual({ added: [], removed: [], missingFromApp: [] });
		return { commands: builtin.length, ready };
	});

	check("update check output parses without installing an update", async () => {
		const result = await cli(["update", "--check"]);
		const parsed = parseOmpUpdateCheck(result);
		if (result.code === 0) expect(parsed.error).toBeNull();
		else {
			// --check may need the network. Preserve an offline failure rather than claiming an update succeeded.
			expect(parsed.error).toBeTruthy();
			expect(`${result.stdout}\n${result.stderr}`).toMatch(/Failed to check for updates:/);
		}
		if (!parsed.managedBy) expect(parsed.currentVersion).toBe(version);
		return { ...parsed, exitCode: result.code };
	});

	it("collab protocol matches the app when matching release source is provided", async context => {
		if (!process.env.OMP_WIRE_SOURCE) {
			evidence.collabProtocol = { status: "skipped", reason: "OMP_WIRE_SOURCE is unset. RPC does not expose the collab protocol version." };
			context.skip();
			return;
		}
		try {
			const source = await readFile(process.env.OMP_WIRE_SOURCE, "utf8");
			const match = /export\s+const\s+COLLAB_PROTO\s*=\s*(\d+)\s*;/.exec(source);
			expect(match, "Upstream COLLAB_PROTO declaration was not found").not.toBeNull();
			const upstream = Number(match![1]);
			evidence.collabProtocol = { status: upstream === COLLAB_PROTO ? "passed" : "failed", upstream, app: COLLAB_PROTO, provenance: "Matching release source, rather than a live collab handshake" };
			expect(upstream).toBe(COLLAB_PROTO);
		} catch (error) {
			evidence.collabProtocol = { status: "failed", error: error instanceof Error ? error.message : String(error) };
			throw error;
		}
	});
});
