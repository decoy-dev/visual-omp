import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpListResult } from "@shared/contracts/mcp";
import { register } from "../mcp";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	files: {} as Record<string, string>, reads: [] as string[], prompt: vi.fn(), test: vi.fn(), json: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getVersion: () => "0.7.0" }, BrowserWindow: { getFocusedWindow: () => null }, dialog: { showMessageBox: (...args: unknown[]) => fake.prompt(...args) } }));
vi.mock("../../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler), broadcast: vi.fn() }));
vi.mock("../../env", () => ({ userEnv: async () => ({ API_TOKEN: "fixture-secret", PI_CODING_AGENT_DIR: "/agent" }) }));
vi.mock("../../omp/paths", () => ({ agentDir: () => "/agent" }));
vi.mock("../../omp/config-file", () => ({ NEUTRAL_CWD: "/neutral" }));
vi.mock("../../omp/cli", () => ({ runOmpJson: (...args: unknown[]) => fake.json(...args), runOmp: vi.fn() }));
vi.mock("./client", () => ({ testServer: (...args: unknown[]) => fake.test(...args) }));
vi.mock("./store", () => ({
	readOptional: async (file: string) => { fake.reads.push(file); return fake.files[file] ?? null; },
	readDocument: async (file: string) => JSON.parse(fake.files[file] ?? "{}"),
}));
register();
const call = (channel: string, ...args: unknown[]) => fake.handlers.get(channel)!(...args);

beforeEach(() => {
	vi.clearAllMocks(); fake.reads = [];
	fake.files = {
		"/agent/mcp.json": JSON.stringify({ mcpServers: { user: { type: "http", url: "https://user.example/mcp" } } }),
		"/project/.omp/mcp.json": JSON.stringify({ mcpServers: { project: { command: "hostile-project-command" } } }),
		"/project/opencode.json": JSON.stringify({ mcp: {
			chosen: { type: "remote", url: "https://chosen.example/mcp", headers: { Authorization: "{env:API_TOKEN}", Extra: "{file:/chosen-secret}" } },
			sibling: { type: "remote", url: "https://sibling.example/mcp", headers: { Extra: "{file:/sibling-secret}" } },
		} }),
		"/chosen-secret": "chosen fixture", "/sibling-secret": "never read",
	};
	fake.json.mockReset().mockResolvedValue({});
	fake.prompt.mockReset().mockResolvedValue({ response: 1 });
	fake.test.mockReset().mockResolvedValue({ ok: true });
});

describe("MCP main-enforced per-invocation authorization", () => {
	it("does not resolve project file or environment references while listing", async () => {
		const list = await call("mcp:list", "/project") as McpListResult;
		const chosen = list.servers.find(entry => entry.name === "chosen");
		expect(chosen?.config.headers).toEqual({ Authorization: "{env:API_TOKEN}", Extra: "{file:/chosen-secret}" });
		expect(fake.reads).not.toContain("/chosen-secret"); expect(fake.reads).not.toContain("/sibling-secret");
		expect(fake.json).toHaveBeenCalledWith(["config", "list", "--json"], { cwd: "/neutral", timeoutMs: 20_000 });
		expect(fake.test).not.toHaveBeenCalled();
	});

	it("ignores renderer config for automatic checks and resolves a fresh user-source ID in neutral cwd", async () => {
		await call("mcp:test", { command: "renderer-injected-command" }, { automatic: true, serverId: "/agent/mcp.json#user" });
		expect(fake.test).toHaveBeenCalledWith(expect.objectContaining({ config: { type: "http", url: "https://user.example/mcp" }, cwd: "/neutral" }));
		expect(fake.prompt).not.toHaveBeenCalled();
		expect(fake.reads).not.toContain("/project/.omp/mcp.json");
	});

	it("rejects background project requests and unsaved configs without execution or prompting", async () => {
		for (const options of [{ automatic: true }, { automatic: true, cwd: "/project", serverId: "/project/.omp/mcp.json#project" }, { automatic: true, serverId: "/project/.omp/mcp.json#project" }]) {
			await expect(call("mcp:test", { command: "hostile" }, options)).rejects.toThrow();
		}
		expect(fake.test).not.toHaveBeenCalled(); expect(fake.prompt).not.toHaveBeenCalled();
	});

	it("cancels an explicit project check before commands or substitutions", async () => {
		fake.prompt.mockResolvedValue({ response: 0 });
		await expect(call("mcp:test", {}, { cwd: "/project", serverId: "/project/opencode.json#chosen" })).rejects.toThrow("cancelled");
		expect(fake.test).not.toHaveBeenCalled();
		expect(fake.reads).not.toContain("/chosen-secret"); expect(fake.reads).not.toContain("/sibling-secret");
	});

	it("resolves only the explicitly authorized project's server after the native decision", async () => {
		fake.prompt.mockImplementation(async options => {
			expect(options).toMatchObject({ message: "chosen (This project)", defaultId: 0 });
			expect(options.detail).toContain("Folder: /project"); expect(options.detail).toContain("https://chosen.example/mcp");
			expect(fake.reads).not.toContain("/chosen-secret"); expect(fake.test).not.toHaveBeenCalled();
			return { response: 1 };
		});
		await call("mcp:test", {}, { cwd: "/project", serverId: "/project/opencode.json#chosen" });
		expect(fake.test).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ headers: { Authorization: "fixture-secret", Extra: "chosen fixture" } }), cwd: "/project" }));
		expect(fake.reads).toContain("/chosen-secret"); expect(fake.reads).not.toContain("/sibling-secret");
	});

	it("requires native permission for an unsaved editor configuration too", async () => {
		fake.prompt.mockResolvedValue({ response: 0 });
		await expect(call("mcp:test", { command: "unsaved-command" }, { cwd: "/project", serverName: "New server" })).rejects.toThrow("cancelled");
		expect(fake.prompt.mock.calls[0]?.[0].detail).toContain("unsaved-command");
		expect(fake.test).not.toHaveBeenCalled();
	});
});
