import { beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "./config";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	global: ["AGENTS.local.md"] as string[],
	project: null as string[] | null,
	write: vi.fn(),
}));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler), broadcast: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ newUserApproval: "done" }), setPrefs: vi.fn() }));
vi.mock("../omp/rpc", () => ({ rpcRequest: vi.fn() }));
vi.mock("../omp/cli", () => ({ runOmp: async (args: string[]) => {
	if (args[0] === "config") {
		const value = args[3] === "project" ? fake.project : fake.global;
		return { code: 0, stderr: "", stdout: JSON.stringify(value === null ? {} : { "contextFiles.extra": { value, type: "array", description: "Extra filenames" } }) };
	}
	return { code: 0, stderr: "", stdout: `contextFiles.extra: ${JSON.stringify(fake.project ?? fake.global)}\ntype: array\ndefault: []\nsource: ${fake.project === null ? "global config" : "project config"}\ndescription: Extra filenames` };
} }));
vi.mock("../omp/config-file", () => ({
	NEUTRAL_CWD: "/tmp",
	configFile: async (scope: string) => `/fixture/${scope}.yml`,
	setConfigPath: (...args: unknown[]) => fake.write(...args),
}));
register();
const call = (channel: string, ...args: unknown[]) => fake.handlers.get(channel)!(...args);

beforeEach(() => {
	fake.global = ["AGENTS.local.md"];
	fake.project = null;
	fake.write.mockReset();
	fake.write.mockImplementation((scope: string, _cwd: string, _path: string[], value: string[]) => {
		if (scope === "project") fake.project = [...value];
		else fake.global = [...value];
	});
});

describe("extra instruction configuration writes", () => {
	it.each(["../outside.md", "folder/file.md", "folder\\file.md", "AGENTS.md", "claude.md", "GEMINI.md", "RULES.md", ".", "..", "", "bad\0name"])("rejects invalid addition %j before changing configuration", async name => {
		await expect(call("config:set", "contextFiles.extra", [...fake.global, name], "project", "/fixture/project")).rejects.toThrow("Invalid extra instruction filename");
		expect(fake.write).not.toHaveBeenCalled();
		expect(fake.global).toEqual(["AGENTS.local.md"]);
		expect(fake.project).toBeNull();
	});
	it("writes a valid project addition while retaining inherited filenames and leaving the global list unchanged", async () => {
		const inherited = await call("config:get", "contextFiles.extra", "/fixture/project") as { value: string[] };
		const result = await call("config:set", "contextFiles.extra", [...inherited.value, "TEAM.md"], "project", "/fixture/project");
		expect(fake.project).toEqual(["AGENTS.local.md", "TEAM.md"]);
		expect(fake.global).toEqual(["AGENTS.local.md"]);
		expect(result).toMatchObject({ setting: { value: ["AGENTS.local.md", "TEAM.md"], source: "project" }, shadowedBy: null });
	});
});
