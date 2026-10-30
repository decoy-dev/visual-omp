import { readFile, stat } from "node:fs/promises";
import type * as PathModule from "node:path";
import { join, resolve, win32 } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpReauthOptions } from "@shared/contracts/mcp";
import { register } from "../mcp";
import { OMP_MCP_DISCOVERY_PROVIDERS } from "../../omp/discovery-isolation";

const fake = vi.hoisted(() => ({
	windowsPaths: false,
	paths: { agent: "", project: "", neutral: "", userConfig: "", projectConfig: "" },
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	run: vi.fn(), json: vi.fn(), prompt: vi.fn(), read: vi.fn(),
}));
vi.mock("node:path", async importOriginal => {
	const actual = await importOriginal<typeof PathModule>();
	return {
		...actual,
		// Only config lookups use simulated Windows paths; overlay files use the host filesystem.
		join: (...parts: string[]) => fake.windowsPaths && (parts[0] === fake.paths.agent || parts[0] === fake.paths.project)
			? actual.win32.join(...parts) : actual.join(...parts),
	};
});
vi.mock("electron", () => ({ app: { getVersion: () => "0.7.0" }, BrowserWindow: { getFocusedWindow: () => null }, dialog: { showMessageBox: (...args: unknown[]) => fake.prompt(...args) } }));
vi.mock("../../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler), broadcast: vi.fn() }));
vi.mock("../../env", () => ({ userEnv: async () => ({ PI_CODING_AGENT_DIR: fake.paths.agent }) }));
vi.mock("../../omp/paths", () => ({ agentDir: () => fake.paths.agent }));
vi.mock("../../omp/cli", () => ({ runOmp: (...args: unknown[]) => fake.run(...args), runOmpJson: (...args: unknown[]) => fake.json(...args) }));
vi.mock("../../omp/config-file", () => ({ get NEUTRAL_CWD() { return fake.paths.neutral; } }));
vi.mock("./store", () => ({ readDocument: (...args: unknown[]) => fake.read(...args) }));
register();
const reauth = (name: string, options: McpReauthOptions) => fake.handlers.get("mcp:reauth")!(name, options);
const selected = { type: "http", url: "https://chosen.example/mcp", headers: { Authorization: "!project-header-command" } };

describe.each(["native", "win32"] as const)("authorized MCP browser sign-in with %s paths", pathStyle => {
	beforeEach(() => {
		vi.clearAllMocks();
		fake.windowsPaths = pathStyle === "win32";
		const path = fake.windowsPaths ? win32 : { resolve, join };
		const root = path.resolve(fake.windowsPaths ? "C:\\fixtures" : "/fixtures");
		const agent = path.join(root, "agent");
		const project = path.join(root, "projects", "selected folder");
		fake.paths = {
			agent, project, neutral: path.join(root, "neutral"),
			userConfig: path.join(agent, "mcp.json"), projectConfig: path.join(project, ".omp", "mcp.json"),
		};
		fake.run.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		fake.json.mockReset().mockResolvedValue({});
		fake.prompt.mockReset().mockResolvedValue({ response: 1 });
		fake.read.mockReset().mockImplementation(async () => ({ mcpServers: { Slack: selected, "MaaS Slack": selected, "cloudflare:cloudflare-api": selected, ["a".repeat(100)]: selected, hostile: { command: "never-run-sibling" } } }));
	});
	it.each(["MaaS Slack", "cloudflare:cloudflare-api", "a".repeat(100)])("confirms %s before settings or subprocesses, and suppresses ambient discovery", async name => {
		let overlay = "";
		fake.prompt.mockImplementation(async options => {
			expect(options).toMatchObject({ defaultId: 0, cancelId: 0, message: `${name} (This project)` });
			expect(options.detail).toContain(fake.paths.project);
			expect(options.detail).toContain("https://chosen.example/mcp");
			expect(options.detail).toContain("configured commands");
			expect(fake.json).not.toHaveBeenCalled();
			expect(fake.run).not.toHaveBeenCalled();
			return { response: 1 };
		});
		fake.run.mockImplementation(async (argv: string[], options) => {
			expect(options).toEqual({ cwd: fake.paths.project, timeoutMs: 360_000 });
			expect(argv.slice(-2)).toEqual(["-p", `/mcp reauth ${name}`]);
			expect(argv).toEqual(expect.arrayContaining(["--no-extensions", "--no-tools", "--no-lsp", "--no-skills", "--no-rules", "--no-context-files"]));
			overlay = argv[argv.indexOf("--config") + 1]!;
			const settings = JSON.parse(await readFile(overlay, "utf8"));
			expect(settings).toEqual({ disabledProviders: OMP_MCP_DISCOVERY_PROVIDERS, mcp: { enableProjectConfig: true } });
			// Registry root key, covering native, every foreign source and all three plugin providers.
			expect(settings.disabledProviders).toEqual(["native", "claude", "codex", "gemini", "opencode", "cursor", "windsurf", "vscode", "mcp-json", "omp-plugins", "claude-plugins", "agent-plugins"]);
			if (process.platform !== "win32") expect((await stat(overlay)).mode & 0o777).toBe(0o600);
			return { code: 0, stdout: "", stderr: "" };
		});
		await expect(reauth(name, { scope: "project", cwd: fake.paths.project })).resolves.toBeUndefined();
		expect(fake.run).toHaveBeenCalledOnce();
		await expect(stat(overlay)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("cancels before project settings, subprocesses or header commands", async () => {
		fake.prompt.mockResolvedValue({ response: 0 });
		await expect(reauth("Slack", { scope: "project", cwd: fake.paths.project })).rejects.toThrow("cancelled");
		expect(fake.json).not.toHaveBeenCalled();
		expect(fake.run).not.toHaveBeenCalled();
	});

	it("selects the exact native scope and excludes project discovery for user sign-in", async () => {
		fake.read.mockImplementation(async file => ({ mcpServers: { Slack: { ...selected, url: file === fake.paths.userConfig ? "https://user.example/mcp" : "https://project.example/mcp" } } }));
		fake.run.mockImplementation(async (argv: string[]) => {
			const overlay = JSON.parse(await readFile(argv[argv.indexOf("--config") + 1]!, "utf8"));
			expect(overlay.mcp.enableProjectConfig).toBe(false);
			return { code: 0, stdout: "", stderr: "" };
		});
		await reauth("Slack", { scope: "user", cwd: fake.paths.project });
		expect(fake.prompt.mock.calls[0]?.[0].detail).toContain("https://user.example/mcp");
		expect(fake.read).toHaveBeenCalledWith(fake.paths.userConfig);
		expect(fake.read).not.toHaveBeenCalledWith(fake.paths.projectConfig);
		expect(fake.json).not.toHaveBeenCalled();
	});

	it("refuses missing or changed selected entries instead of using a same-name fallback", async () => {
		fake.read.mockResolvedValueOnce({ mcpServers: {} });
		await expect(reauth("Slack", { scope: "project", cwd: fake.paths.project })).rejects.toThrow("selected scope");
		expect(fake.prompt).not.toHaveBeenCalled();
		fake.read.mockResolvedValueOnce({ mcpServers: { Slack: selected } }).mockResolvedValueOnce({ mcpServers: { Slack: { ...selected, url: "https://changed.example" } } });
		await expect(reauth("Slack", { scope: "project", cwd: fake.paths.project })).rejects.toThrow("configuration changed");
		expect(fake.run).not.toHaveBeenCalled();
	});

	it("refuses project scope without a folder and an excluded project server after confirmation", async () => {
		await expect(reauth("Slack", { scope: "project" })).rejects.toThrow("Choose a project folder");
		fake.json.mockResolvedValue({ "mcp.enableProjectConfig": { value: false } });
		await expect(reauth("Slack", { scope: "project", cwd: fake.paths.project })).rejects.toThrow("Project MCP servers are turned off");
		expect(fake.run).not.toHaveBeenCalled();
	});

	it.each(["", " ", "has  double spaces", "has\nnewline", "bad;name", "bad/name", "a".repeat(101)])("rejects invalid name %j without starting omp", async name => {
		await expect(reauth(name, { scope: "project", cwd: fake.paths.project })).rejects.toThrow("Server name");
		expect(fake.run).not.toHaveBeenCalled();
		expect(fake.prompt).not.toHaveBeenCalled();
	});

	it("reports CLI failure and cleans its overlay", async () => {
		let overlay = "";
		fake.run.mockImplementation(async (argv: string[]) => { overlay = argv[argv.indexOf("--config") + 1]!; return { code: 7, stdout: "", stderr: "Callback failed." }; });
		await expect(reauth("Slack", { scope: "user" })).rejects.toThrow("exited with 7.\nCallback failed.");
		await expect(stat(overlay)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
