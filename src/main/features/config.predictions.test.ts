import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { getSetting, register } from "./config";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), value: null as boolean | null, project: null as boolean | null,
	write: vi.fn(), broadcast: vi.fn(), failures: new Map<string, Error>(), reads: [] as { args: string[]; cwd: string }[],
	source: null as string | null, effective: undefined as boolean | undefined,
}));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler), broadcast: fake.broadcast }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ newUserApproval: "done" }), setPrefs: vi.fn() }));
vi.mock("../omp/rpc", () => ({ rpcRequest: vi.fn() }));
vi.mock("../omp/cli", () => ({ runOmp: async (args: string[], { cwd }: { cwd: string }) => {
	fake.reads.push({ args, cwd });
	if (fake.failures.has(cwd)) throw fake.failures.get(cwd);
	const project = cwd === "/tmp" ? null : fake.project;
	if (args[0] === "config") {
		const value = args[3] === "project" ? project : fake.value;
		return { code: 0, stderr: "", stdout: JSON.stringify(value === null ? {} : { "composer.predictions": { value, type: "boolean", description: "Next-message predictions" } }) };
	}
	return { code: 0, stderr: "", stdout: `composer.predictions: ${fake.effective ?? project ?? fake.value ?? false}\ntype: boolean\ndefault: false\nsource: ${fake.source ?? (project !== null ? "project config" : fake.value === null ? "default" : "global config")}\ndescription: Next-message predictions` };
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
	fake.failures.clear(); fake.reads = [];
	fake.source = null; fake.effective = undefined;
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

it.each(["ENOENT", "ENOTDIR"] as const)("reads global effective settings for a removed saved worktree (%s), through both callers", async code => {
	const root = await mkdtemp(join(tmpdir(), "vomp-config-saved-"));
	try {
		const cwd = code === "ENOENT" ? join(root, "removed-worktree") : join(root, "file", "worktree");
		if (code === "ENOTDIR") await writeFile(join(root, "file"), "regular file");
		fake.failures.set(cwd, new Error("omp could not start in saved folder"));
		fake.value = true; fake.project = false;
		for (const read of [
			() => getSetting("composer.predictions", cwd),
			() => call("config:get", "composer.predictions", cwd),
		]) {
			fake.reads = [];
			expect(await read()).toMatchObject({ value: true, source: "global", globalValue: true, projectValue: null });
			const fallback = fake.reads.filter(read => read.cwd === "/tmp");
			expect(fallback.map(read => read.args)).toEqual(expect.arrayContaining([
				["read", "cfg://composer.predictions"],
				["config", "list", "--scope", "global", "--json"],
			]));
			expect(fallback.some(read => read.args.includes("project"))).toBe(false);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

it("retains a present worktree's project override and source metadata", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "vomp-config-project-"));
	try {
		fake.value = true; fake.project = false;
		expect(await getSetting("composer.predictions", cwd)).toMatchObject({ value: false, source: "project", globalValue: true, projectValue: false });
		expect(fake.reads.every(read => read.cwd === cwd)).toBe(true);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

it.each(["EACCES", "ENOENT", "ENOTDIR", "INVALID_CONFIG"])("preserves %s failures when the saved folder still exists", async code => {
	const cwd = await mkdtemp(join(tmpdir(), "vomp-config-errors-"));
	try {
		const error = Object.assign(new Error("Original omp failure"), { code });
		fake.failures.set(cwd, error);
		await expect(getSetting("composer.predictions", cwd)).rejects.toBe(error);
		expect(fake.reads.every(read => read.cwd === cwd)).toBe(true);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

it("does not retry a failed no-project setting read", async () => {
	const error = new Error("Global config failed");
	fake.failures.set("/tmp", error);
	await expect(getSetting("composer.predictions", undefined)).rejects.toBe(error);
	expect(fake.reads).toHaveLength(2);
});

it("preserves omp's higher-priority effective source after removing project scope", async () => {
	const root = await mkdtemp(join(tmpdir(), "vomp-config-source-"));
	try {
		const cwd = join(root, "deleted");
		fake.failures.set(cwd, new Error("Saved folder missing"));
		fake.value = false; fake.project = false; fake.effective = true; fake.source = "environment variable";
		expect(await getSetting("composer.predictions", cwd)).toMatchObject({ value: true, source: "env", globalValue: false, projectValue: null });
	} finally { await rm(root, { recursive: true, force: true }); }
});
