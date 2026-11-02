import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Document, parseDocument } from "yaml";
import { deepMerge, getPath } from "../services/omp-config";
import { register } from "./config";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	global: "", project: "", writes: [] as string[], storage: "global",
}));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler), broadcast: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ newUserApproval: "done" }), setPrefs: vi.fn() }));
vi.mock("../omp/rpc", () => ({ rpcRequest: vi.fn() }));
vi.mock("../omp/config-file", () => ({
	NEUTRAL_CWD: "/fixture/neutral",
	configFile: async (scope: string) => `/fixture/${scope}.yml`,
	editConfig: async (scope: "global" | "project", _cwd: string, edit: (doc: Document) => void) => {
		const doc = parseDocument(fake[scope]);
		edit(doc);
		fake[scope] = doc.toString();
		fake.writes.push(scope);
	},
}));
vi.mock("../omp/cli", () => ({ runOmp: async (args: string[]) => {
	const data = deepMerge(parseDocument(fake.global).toJSON() ?? {}, parseDocument(fake.project).toJSON() ?? {})!;
	const chains = getPath(data, ["retry", "fallbackChains"]) ?? {};
	if (args[0] === "config") {
		const scoped = args.includes("--scope");
		const layer = scoped ? parseDocument(args[3] === "global" ? fake.global : fake.project).toJSON() ?? {} : data;
		return { code: 0, stderr: "", stdout: JSON.stringify({
			"retry.fallbackChains": { value: getPath(layer, ["retry", "fallbackChains"]) ?? {}, type: "record", description: "Fallbacks" },
			modelRoles: { value: getPath(layer, ["modelRoles"]) ?? {}, type: "record", description: "Roles" },
		}) };
	}
	const key = args[1]!.slice(6);
	const value = key === "modelRoleStorage" ? fake.storage : key === "defaultThinkingLevel" ? "high" : chains;
	return { code: 0, stderr: "", stdout: `${key}: ${JSON.stringify(value)}\ntype: ${key === "retry.fallbackChains" ? "record" : "enum"}\ndefault: ${key === "retry.fallbackChains" ? "{}" : JSON.stringify(value)}\nsource: global config` };
} }));
register();
const call = (role: string, chain: string[] | null, scope?: "global" | "project") => fake.handlers.get("config:roles:fallbacks")!(role, chain, { cwd: "/fixture/project", scope });
const chains = (scope: "global" | "project") => parseDocument(fake[scope]).toJSON()?.retry?.fallbackChains;

beforeEach(() => {
	fake.global = '# Keep my routing\nretry:\n  fallbackChains:\n    default: [openai-codex/gpt-6-luna]\n    "provider/model.with.dots": [provider/other:high] # preserve\n    "provider/*": [backup/*]\n    broken: [23, null]\n    image: []\n';
	fake.project = "";
	fake.writes = [];
	fake.storage = "global";
});

describe("role fallback configuration", () => {
	it("patches the exact role through YAML while preserving model keys, malformed entries and comments", async () => {
		const result = await call("default", ["provider/second", "openai-codex/gpt-6-luna:high", "provider/second"]);
		expect(chains("global")).toEqual({ default: ["provider/second", "openai-codex/gpt-6-luna:high"], "provider/model.with.dots": ["provider/other:high"], "provider/*": ["backup/*"], broken: [23, null], image: [] });
		expect(fake.global).toContain("# Keep my routing");
		expect(fake.global).toContain("# preserve");
		expect(result).toMatchObject({ setting: { value: chains("global") } });
	});
	it("removes the key for an empty edit, but can explicitly disable kind-role fallbacks", async () => {
		await call("default", []);
		expect(chains("global")).not.toHaveProperty("default");
		await call("web", null);
		expect(chains("global").web).toEqual([]);
	});
	it("uses role storage by default and allows the section's explicit scope without copying other layers", async () => {
		fake.storage = "project";
		await call("default", ["project/model"]);
		expect(chains("project")).toEqual({ default: ["project/model"] });
		expect(chains("global").default).toEqual(["openai-codex/gpt-6-luna"]);
		await call("plan", ["global/model"], "global");
		expect(chains("global").plan).toEqual(["global/model"]);
		expect(chains("project")).not.toHaveProperty("plan");
	});
	it.each(["retry: malformed\n", "retry:\n  fallbackChains: [malformed]\n"])("refuses malformed parent records without replacing them: %s", async text => {
		fake.global = text;
		await expect(call("default", ["provider/model"])).rejects.toThrow("not a mapping");
		expect(fake.global).toBe(text);
		expect(fake.writes).toEqual([]);
	});
	it("rejects model-oriented keys and malformed edits before writing", async () => {
		await expect(call("provider/*", ["provider/model"])).rejects.toThrow("Invalid role");
		await expect(call("default", [42 as unknown as string])).rejects.toThrow();
		expect(fake.writes).toEqual([]);
	});
	it("reads owner-like and fallback-only custom roles through omp's effective listing", async () => {
		fake.project = "retry:\n  fallbackChains:\n    customRole: [project/fallback]\n";
		const result = await fake.handlers.get("config:roles")!("/fixture/project") as { roles: { id: string }[] };
		expect(result.roles[0]?.id).toBe("default");
		expect(result.roles.some(role => role.id === "customRole")).toBe(true);
		expect(result.roles.some(role => role.id.includes("/"))).toBe(false);
	});
});
