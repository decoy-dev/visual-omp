import { beforeEach, expect, it, vi } from "vitest";
import { register } from "./config";

const fake = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), value: null as boolean | null, project: null as boolean | null, write: vi.fn(), broadcast: vi.fn() }));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler), broadcast: fake.broadcast }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ newUserApproval: "done" }), setPrefs: vi.fn() }));
vi.mock("../omp/rpc", () => ({ rpcRequest: vi.fn() }));
vi.mock("../omp/cli", () => ({ runOmp: async (args: string[]) => {
	if (args[0] === "config") {
		const value = args[3] === "project" ? fake.project : fake.value;
		return { code: 0, stderr: "", stdout: JSON.stringify(value === null ? {} : { "composer.predictions": { value, type: "boolean", description: "Next-message predictions" } }) };
	}
	return { code: 0, stderr: "", stdout: `composer.predictions: ${fake.project ?? fake.value ?? false}\ntype: boolean\ndefault: false\nsource: ${fake.project !== null ? "project config" : fake.value === null ? "default" : "global config"}\ndescription: Next-message predictions` };
} }));
vi.mock("../omp/config-file", () => ({
	NEUTRAL_CWD: "/tmp", configFile: async (scope: string) => `/fixture/${scope}.yml`,
	setConfigPath: (...args: unknown[]) => fake.write(...args),
	deleteConfigPath: async () => { fake.value = null; },
}));
register();
const call = (channel: string, ...args: unknown[]) => fake.handlers.get(channel)!(...args);
beforeEach(() => {
	fake.value = null; fake.project = null; fake.broadcast.mockClear();
	fake.write.mockReset().mockImplementation(async (_scope: string, _cwd: string, _path: string[], value: boolean) => { fake.value = value; });
});
it.each([null, true, false])("reads omp's own effective setting, with no app default (%s)", async value => {
	fake.value = value;
	expect(await call("config:get", "composer.predictions", "/fixture/project")).toMatchObject({ value: value ?? false, source: value === null ? "default" : "global" });
});
it("preserves an explicit project setting", async () => {
	fake.value = true; fake.project = false;
	expect(await call("config:get", "composer.predictions", "/fixture/project")).toMatchObject({ value: false, source: "project" });
});
it.each([true, false])("saves the global choice %s and refreshes consumers", async value => {
	const result = await call("config:set", "composer.predictions", value, "global", "/fixture/project");
	expect(fake.write).toHaveBeenCalledWith("global", "/fixture/project", ["composer", "predictions"], value);
	expect(result).toMatchObject({ setting: { value, source: "global" }, shadowedBy: null });
	expect(fake.broadcast).toHaveBeenCalledWith("config:changed", { scope: "global", cwd: null, file: "/fixture/global.yml", origin: "app" });
});
it("returns to omp's off default after Advanced resets the explicit setting", async () => {
	fake.value = true;
	expect(await call("config:reset", "composer.predictions", "global", "/fixture/project")).toMatchObject({ setting: { value: false, source: "default" } });
	expect(fake.broadcast).toHaveBeenCalledWith("config:changed", { scope: "global", cwd: null, file: "/fixture/global.yml", origin: "app" });
});
