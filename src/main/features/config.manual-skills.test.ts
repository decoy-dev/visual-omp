import { beforeEach, expect, it, vi } from "vitest";
import { register } from "./config";

const fake = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), value: null as string[] | null, write: vi.fn(), broadcast: vi.fn() }));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler), broadcast: fake.broadcast }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ newUserApproval: "done" }), setPrefs: vi.fn() }));
vi.mock("../omp/rpc", () => ({ rpcRequest: vi.fn() }));
vi.mock("../omp/cli", () => ({ runOmp: async (args: string[]) => {
	if (args[0] === "config") return { code: 0, stderr: "", stdout: JSON.stringify(fake.value === null ? {} : { "skills.manualSkills": { value: fake.value, type: "array", description: "Manual-only skills" } }) };
	return { code: 0, stderr: "", stdout: `skills.manualSkills: ${JSON.stringify(fake.value ?? [])}\ntype: array\ndefault: []\nsource: ${fake.value === null ? "default" : "global config"}\ndescription: Manual-only skills` };
} }));
vi.mock("../omp/config-file", () => ({
	NEUTRAL_CWD: "/tmp", configFile: async (scope: string) => `/fixture/${scope}.yml`,
	setConfigPath: (...args: unknown[]) => fake.write(...args),
	deleteConfigPath: async () => { fake.value = null; },
}));
register();
beforeEach(() => {
	fake.value = null; fake.broadcast.mockClear();
	fake.write.mockReset().mockImplementation(async (_scope: string, _cwd: string, _path: string[], value: string[]) => { fake.value = value; });
});
it.each([{ value: ["docs-*", "internal/**"] }, { value: [] }])("saves $value and refreshes the skill catalog through the existing config event", async ({ value }) => {
	const result = await fake.handlers.get("config:set")!("skills.manualSkills", value, "global");
	expect(fake.write).toHaveBeenCalledWith("global", undefined, ["skills", "manualSkills"], value);
	expect(result).toMatchObject({ setting: { value, source: "global" }, shadowedBy: null });
	expect(fake.broadcast).toHaveBeenCalledWith("config:changed", { scope: "global", cwd: null, file: "/fixture/global.yml", origin: "app" });
});
it("refreshes consumers when Advanced resets manual-only patterns", async () => {
	fake.value = ["docs-*"];
	expect(await fake.handlers.get("config:reset")!("skills.manualSkills", "global")).toMatchObject({ setting: { value: [], source: "default" } });
	expect(fake.broadcast).toHaveBeenCalledWith("config:changed", { scope: "global", cwd: null, file: "/fixture/global.yml", origin: "app" });
});
