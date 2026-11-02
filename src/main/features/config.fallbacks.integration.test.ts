import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import type { JsonValue, SettingInfo } from "@shared/contracts/config";
import { deepMerge, getPath } from "../services/omp-config";
import { setConfigPath } from "../omp/config-file";
import { register } from "./config";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	agent: "", project: "",
}));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler), broadcast: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ newUserApproval: "done" }), setPrefs: vi.fn() }));
vi.mock("../omp/rpc", () => ({ rpcRequest: vi.fn() }));
// Only CLI reads are substituted. editConfig, its queue, atomic writes and YAML edits are production code.
vi.mock("../omp/cli", () => ({ runOmp: async (args: string[]) => {
	if (args[0] === "config" && args[1] === "path") return { code: 0, stderr: "", stdout: fake.agent };
	const global = parseDocument(await readFile(join(fake.agent, "config.yml"), "utf8")).toJSON() as JsonValue;
	const project = parseDocument(await readFile(join(fake.project, ".omp", "config.yml"), "utf8")).toJSON() as JsonValue;
	const effective = deepMerge(global, project);
	const defaults: Record<string, JsonValue> = { "retry.fallbackChains": {}, "retry.modelFallback": true, "retry.fallbackOn": "any", "retry.fallbackRevertPolicy": "cooldown-expiry", modelRoles: {} };
	if (args[0] === "config" && args[1] === "list") {
		const scope = args.indexOf("--scope");
		const data = scope < 0 ? effective : args[scope + 1] === "global" ? global : project;
		const listed = Object.fromEntries(Object.keys(defaults).flatMap(key => {
			const value = getPath(data, key.split("."));
			if (scope >= 0 && value === undefined) return [];
			return [[key, { type: key === "retry.modelFallback" ? "boolean" : key === "retry.fallbackOn" || key === "retry.fallbackRevertPolicy" ? "enum" : "record", description: key, value: value ?? defaults[key] }]];
		}));
		return { code: 0, stderr: "", stdout: JSON.stringify(listed) };
	}
	const key = args[1]!.slice("cfg://".length);
	const value = getPath(effective, key.split(".")) ?? defaults[key];
	const globalValue = getPath(global, key.split("."));
	const projectValue = getPath(project, key.split("."));
	const type = key === "retry.modelFallback" ? "boolean" : key === "retry.fallbackOn" || key === "retry.fallbackRevertPolicy" ? "enum" : "record";
	const source = projectValue !== undefined && projectValue !== null ? "project config" : globalValue !== undefined && globalValue !== null ? "global config" : "default";
	const values = key === "retry.fallbackOn" ? '\nvalues: [any, usage-limit, except-usage-limit]' : key === "retry.fallbackRevertPolicy" ? '\nvalues: [cooldown-expiry, never]' : "";
	return { code: 0, stderr: "", stdout: `${key}: ${JSON.stringify(value)}\ntype: ${type}\ndefault: ${JSON.stringify(defaults[key])}\nsource: ${source}${values}` };
} }));
register();
let root: string;
const ownerConfig = '# Keep my routing\nmodelRoles:\n  default: anthropic/claude-opus-5-5:xhigh # primary stays unchanged\n  plan: anthropic/claude-opus-5-5:high\nretry:\n  modelFallback: true\n  fallbackChains:\n    default: [openai-codex/gpt-6-luna]\n    "provider/model.with.dots": [provider/other:high] # exact chain\n    "provider/*": [backup/*]\n    broken: [23, null]\n';
const call = (role: string, chain: string[] | null, scope: "global" | "project") => fake.handlers.get("config:roles:fallbacks")!(role, chain, { cwd: fake.project, scope });
const globalDocument = async () => parseDocument(await readFile(join(fake.agent, "config.yml"), "utf8")).toJSON();
const projectDocument = async () => parseDocument(await readFile(join(fake.project, ".omp", "config.yml"), "utf8")).toJSON();
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "vomp-fallback-transaction-"));
	fake.agent = join(root, "agent"); fake.project = join(root, "project");
	await mkdir(fake.agent, { recursive: true }); await mkdir(join(fake.project, ".omp"), { recursive: true });
});
beforeEach(async () => {
	await writeFile(join(fake.agent, "config.yml"), ownerConfig);
	await writeFile(join(fake.project, ".omp", "config.yml"), "{}\n");
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("fallback production YAML transactions", () => {
	it("changes the owner's fallback while preserving the primary, effort, unrelated entries and comments", async () => {
		await call("default", ["provider/second:high", "openai-codex/gpt-6-luna"], "global");
		const saved = await globalDocument();
		expect(saved.modelRoles).toEqual({ default: "anthropic/claude-opus-5-5:xhigh", plan: "anthropic/claude-opus-5-5:high" });
		expect(saved.retry.modelFallback).toBe(true);
		expect(saved.retry.fallbackChains).toEqual({ default: ["provider/second:high", "openai-codex/gpt-6-luna"], "provider/model.with.dots": ["provider/other:high"], "provider/*": ["backup/*"], broken: [23, null] });
		const text = await readFile(join(fake.agent, "config.yml"), "utf8");
		expect(text).toContain("  default: anthropic/claude-opus-5-5:xhigh # primary stays unchanged");
		expect(text).toContain("# Keep my routing"); expect(text).toContain("# exact chain");
	});
	it("serializes concurrent unrelated writes through the production file queue", async () => {
		await Promise.all([
			call("default", ["provider/second:low"], "global"),
			setConfigPath("global", fake.project, ["retry", "fallbackChains", "provider/*"], ["fresh/*"]),
			setConfigPath("global", fake.project, ["retry", "maxRetries"], 7),
		]);
		const saved = await globalDocument();
		expect(saved.retry.fallbackChains.default).toEqual(["provider/second:low"]);
		expect(saved.retry.fallbackChains["provider/*"]).toEqual(["fresh/*"]);
		expect(saved.retry.fallbackChains["provider/model.with.dots"]).toEqual(["provider/other:high"]);
		expect(saved.retry.fallbackChains.broken).toEqual([23, null]);
		expect(saved.retry.maxRetries).toBe(7);
	});
	it("keeps different global and project chains isolated and clears only the requested layer", async () => {
		await writeFile(join(fake.project, ".omp", "config.yml"), 'retry:\n  fallbackChains:\n    default: [project/fallback]\n');
		const result = await call("default", ["global/fallback"], "global");
		expect(result).toMatchObject({ setting: { value: { default: ["project/fallback"] }, globalValue: { default: ["global/fallback"] }, projectValue: { default: ["project/fallback"] } }, shadowedBy: "project" });
		await call("default", [], "project");
		expect((await globalDocument()).retry.fallbackChains.default).toEqual(["global/fallback"]);
		expect(await projectDocument()).toEqual({});
	});
	it("writes an explicit empty chat-role chain and removes it to restore inheritance", async () => {
		await call("plan", null, "project");
		expect((await projectDocument()).retry.fallbackChains.plan).toEqual([]);
		expect((await globalDocument()).retry.fallbackChains.default).toEqual(["openai-codex/gpt-6-luna"]);
		await call("plan", [], "project");
		expect(await projectDocument()).toEqual({});
	});
	it("reports effective project-disabled fallback independently of global enabled state", async () => {
		await writeFile(join(fake.project, ".omp", "config.yml"), "retry:\n  modelFallback: false\n");
		const before = await fake.handlers.get("config:get")!("retry.modelFallback", fake.project) as SettingInfo;
		expect(before).toMatchObject({ value: false, globalValue: true, projectValue: false, source: "project" });
		await fake.handlers.get("config:set")!("retry.modelFallback", false, "global", fake.project);
		expect((await globalDocument()).retry.modelFallback).toBe(false);
		expect((await projectDocument()).retry.modelFallback).toBe(false);
	});
	it("does not report unrelated project chains as shadowing the edited global role", async () => {
		await writeFile(join(fake.project, ".omp", "config.yml"), "retry:\n  fallbackChains:\n    plan: [project/plan]\n");
		expect(await call("default", ["global/fallback"], "global")).toMatchObject({ shadowedBy: null });
	});
});
