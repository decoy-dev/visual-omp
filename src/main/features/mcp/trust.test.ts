import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as PathModule from "node:path";
import { join, resolve } from "node:path";
import type { McpListResult } from "@shared/contracts/mcp";
import { register } from "../mcp";

const fake = vi.hoisted(() => ({
	windowsPaths: false,
	paths: { agent: "", project: "", neutral: "", userConfig: "", projectConfig: "", openCode: "", chosenSecret: "", siblingSecret: "" },
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	files: {} as Record<string, string>, reads: [] as string[], prompt: vi.fn(), test: vi.fn(), json: vi.fn(),
}));
vi.mock("node:path", async importOriginal => {
	const actual = await importOriginal<typeof PathModule>();
	return {
		...actual,
		join: (...parts: string[]) => (fake.windowsPaths ? actual.win32 : actual).join(...parts),
		resolve: (...parts: string[]) => (fake.windowsPaths ? actual.win32 : actual).resolve(...parts),
		dirname: (file: string) => (fake.windowsPaths ? actual.win32 : actual).dirname(file),
		isAbsolute: (file: string) => (fake.windowsPaths ? actual.win32 : actual).isAbsolute(file),
	};
});
vi.mock("electron", () => ({ app: { getVersion: () => "0.7.0" }, BrowserWindow: { getFocusedWindow: () => null }, dialog: { showMessageBox: (...args: unknown[]) => fake.prompt(...args) } }));
vi.mock("../../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler), broadcast: vi.fn() }));
vi.mock("../../env", () => ({ userEnv: async () => ({ API_TOKEN: "fixture-secret", PI_CODING_AGENT_DIR: fake.paths.agent }) }));
vi.mock("../../omp/paths", () => ({ agentDir: () => fake.paths.agent }));
vi.mock("../../omp/config-file", () => ({ get NEUTRAL_CWD() { return fake.paths.neutral; } }));
vi.mock("../../omp/cli", () => ({ runOmpJson: (...args: unknown[]) => fake.json(...args), runOmp: vi.fn() }));
vi.mock("./client", () => ({ testServer: (...args: unknown[]) => fake.test(...args) }));
vi.mock("./store", () => ({
	readOptional: async (file: string) => { fake.reads.push(file); return fake.files[file] ?? null; },
	readDocument: async (file: string) => JSON.parse(fake.files[file] ?? "{}"),
}));
register();
const call = (channel: string, ...args: unknown[]) => fake.handlers.get(channel)!(...args);

describe.each(["native", "win32"] as const)("MCP main-enforced per-invocation authorization with %s paths", pathStyle => {
	beforeEach(() => {
		vi.clearAllMocks(); fake.reads = [];
		fake.windowsPaths = pathStyle === "win32";
		const root = resolve(fake.windowsPaths ? "C:\\fixtures" : "/fixtures");
		const agent = join(root, "agent");
		const project = join(root, "project");
		fake.paths = {
			agent, project, neutral: join(root, "neutral"), userConfig: join(agent, "mcp.json"),
			projectConfig: join(project, ".omp", "mcp.json"), openCode: join(project, "opencode.json"),
			chosenSecret: join(project, "chosen-secret"), siblingSecret: join(project, "sibling-secret"),
		};
		fake.files = {
			[fake.paths.userConfig]: JSON.stringify({ mcpServers: { user: { type: "http", url: "https://user.example/mcp" } } }),
			[fake.paths.projectConfig]: JSON.stringify({ mcpServers: { project: { command: "hostile-project-command" } } }),
			[fake.paths.openCode]: JSON.stringify({ mcp: {
				chosen: { type: "remote", url: "https://chosen.example/mcp", headers: { Authorization: "{env:API_TOKEN}", Extra: "{file:./chosen-secret}" } },
				sibling: { type: "remote", url: "https://sibling.example/mcp", headers: { Extra: "{file:./sibling-secret}" } },
			} }),
			[fake.paths.chosenSecret]: "chosen fixture", [fake.paths.siblingSecret]: "never read",
		};
		fake.json.mockReset().mockResolvedValue({});
		fake.prompt.mockReset().mockResolvedValue({ response: 1 });
		fake.test.mockReset().mockResolvedValue({ ok: true });
	});
	it("does not resolve project file or environment references while listing", async () => {
		const list = await call("mcp:list", fake.paths.project) as McpListResult;
		const chosen = list.servers.find(entry => entry.name === "chosen");
		expect(chosen?.config.headers).toEqual({ Authorization: "{env:API_TOKEN}", Extra: "{file:./chosen-secret}" });
		expect(fake.reads).not.toContain(fake.paths.chosenSecret); expect(fake.reads).not.toContain(fake.paths.siblingSecret);
		expect(fake.json).toHaveBeenCalledWith(["config", "list", "--json"], { cwd: fake.paths.neutral, timeoutMs: 20_000 });
		expect(fake.test).not.toHaveBeenCalled();
	});

	it("ignores renderer config for automatic checks and resolves a fresh user-source ID in neutral cwd", async () => {
		await call("mcp:test", { command: "renderer-injected-command" }, { automatic: true, serverId: `${fake.paths.userConfig}#user` });
		expect(fake.test).toHaveBeenCalledWith(expect.objectContaining({ config: { type: "http", url: "https://user.example/mcp" }, cwd: fake.paths.neutral }));
		expect(fake.prompt).not.toHaveBeenCalled();
		expect(fake.reads).not.toContain(fake.paths.projectConfig);
	});

	it("rejects background project requests and unsaved configs without execution or prompting", async () => {
		for (const options of [{ automatic: true }, { automatic: true, cwd: fake.paths.project, serverId: `${fake.paths.projectConfig}#project` }, { automatic: true, serverId: `${fake.paths.projectConfig}#project` }]) {
			await expect(call("mcp:test", { command: "hostile" }, options)).rejects.toThrow();
		}
		expect(fake.test).not.toHaveBeenCalled(); expect(fake.prompt).not.toHaveBeenCalled();
	});

	it("cancels an explicit project check before commands or substitutions", async () => {
		fake.prompt.mockResolvedValue({ response: 0 });
		await expect(call("mcp:test", {}, { cwd: fake.paths.project, serverId: `${fake.paths.openCode}#chosen` })).rejects.toThrow("cancelled");
		expect(fake.test).not.toHaveBeenCalled();
		expect(fake.reads).not.toContain(fake.paths.chosenSecret); expect(fake.reads).not.toContain(fake.paths.siblingSecret);
	});

	it("resolves only the explicitly authorized project's server after the native decision", async () => {
		fake.prompt.mockImplementation(async options => {
			expect(options).toMatchObject({ message: "chosen (This project)", defaultId: 0 });
			expect(options.detail).toContain(`Folder: ${fake.paths.project}`); expect(options.detail).toContain("https://chosen.example/mcp");
			expect(fake.reads).not.toContain(fake.paths.chosenSecret); expect(fake.test).not.toHaveBeenCalled();
			return { response: 1 };
		});
		await call("mcp:test", {}, { cwd: fake.paths.project, serverId: `${fake.paths.openCode}#chosen` });
		expect(fake.test).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ headers: { Authorization: "fixture-secret", Extra: "chosen fixture" } }), cwd: fake.paths.project }));
		expect(fake.reads).toContain(fake.paths.chosenSecret); expect(fake.reads).not.toContain(fake.paths.siblingSecret);
	});

	it("requires native permission for an unsaved editor configuration too", async () => {
		fake.prompt.mockResolvedValue({ response: 0 });
		await expect(call("mcp:test", { command: "unsaved-command" }, { cwd: fake.paths.project, serverName: "New server" })).rejects.toThrow("cancelled");
		expect(fake.prompt.mock.calls[0]?.[0].detail).toContain("unsaved-command");
		expect(fake.test).not.toHaveBeenCalled();
	});
});
