import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProvidersState } from "@shared/contracts/providers";
import { register } from "./providers";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	run: vi.fn(), rpc: vi.fn(), rpcs: vi.fn(), models: vi.fn(), usage: vi.fn(), changed: vi.fn(), broadcast: vi.fn(), save: vi.fn(), open: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => "/tmp" }, BrowserWindow: { getFocusedWindow: () => null }, dialog: { showSaveDialog: fake.save, showOpenDialog: fake.open } }));
vi.mock("../ipc", () => ({ handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(channel, handler), broadcast: fake.broadcast }));
vi.mock("../omp/cli", () => ({ runOmp: fake.run }));
vi.mock("../omp/rpc", () => ({ rpcRequest: fake.rpc, rpcRequests: fake.rpcs }));
vi.mock("../omp/locate", () => ({ ompPath: async () => "/omp" }));
vi.mock("../omp/config-file", () => ({ NEUTRAL_CWD: "/tmp" }));
vi.mock("./config", () => ({ configWritten: fake.changed }));
register();
const call = (channel: string, ...args: unknown[]) => fake.handlers.get(channel)!(...args);
const usage = { reports: [], accountsWithoutUsage: [], disabledCredentials: [] };
const temporary: string[] = [];

beforeEach(async () => {
	vi.clearAllMocks();
	await call("providers:invalidate");
	fake.broadcast.mockClear();
	fake.changed.mockClear();
	fake.usage.mockResolvedValue(usage);
	fake.run.mockImplementation(async (args: string[]) => ({
		code: 0,
		stdout: JSON.stringify(args[0] === "models" ? { models: await fake.models() } : await fake.usage()),
		stderr: "",
	}));
	fake.rpc.mockResolvedValue({ providers: [] });
	fake.rpcs.mockResolvedValue([]);
	fake.models.mockResolvedValue([]);
	fake.save.mockResolvedValue({ canceled: true });
	fake.open.mockResolvedValue({ canceled: true, filePaths: [] });
});
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it("keeps aliased sign-in methods without creating connected rows from inherited authentication", async () => {
	fake.models.mockResolvedValue([{
		provider: "openai-codex", kind: "chat", id: "model", selector: "openai-codex/model",
		name: "Model", contextWindow: null, maxTokens: null, reasoning: false, thinking: null, input: ["text"],
	}]);
	fake.usage.mockResolvedValue({ ...usage, reports: [{ provider: "openai-codex", metadata: { email: "me@example.com" } }] });
	fake.rpc.mockResolvedValue({ providers: [
		{ id: "openai-codex", name: "Codex", authenticated: true },
		{ id: "openai-codex-device", name: "Codex device code", authenticated: true },
		{ id: "future-alias", name: "Future sign-in", authenticated: true },
	] });
	const state = await call("providers:list") as ProvidersState;
	expect(state.connected.map(provider => provider.id)).toEqual(["openai-codex"]);
	expect(state.connected[0]).toMatchObject({ modelCount: 1, authenticated: true, canSignOut: true });
	expect(state.available.map(method => method.id)).toEqual(["openai-codex-device", "future-alias"]);
});

it("keeps a distinct provider when its own accounts or disabled credentials establish it", async () => {
	fake.usage.mockResolvedValue({ ...usage, accountsWithoutUsage: [{ provider: "own-provider", email: "me@example.com" }], disabledCredentials: [{ provider: "disabled-provider", cause: "expired" }] });
	const state = await call("providers:list") as ProvidersState;
	expect(new Set(state.connected.map(provider => provider.id))).toEqual(new Set(["own-provider", "disabled-provider"]));
	expect(state.connected.find(provider => provider.id === "own-provider")).toMatchObject({ name: "own-provider", login: null, canSignOut: true });
});

it("reads provider state outside the selected project without loading extensions or project context", async () => {
	await call("providers:list");
	expect(fake.run).toHaveBeenCalledWith(["models", "--json", "--kind", "all", "--no-extensions"], { cwd: "/tmp", timeoutMs: 60_000 });
	expect(fake.run).toHaveBeenCalledWith(["usage", "--json", "--no-extensions"], { cwd: "/tmp", timeoutMs: 60_000 });
	expect(fake.rpc).toHaveBeenCalledWith("/tmp", "get_login_providers", expect.objectContaining({
		flags: ["--no-session", "--no-lsp", "--no-title", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files"],
	}));
	expect(fake.run).toHaveBeenCalledTimes(2);
	expect(fake.rpc).toHaveBeenCalledOnce();
});

it("shares global discovery between reads and refreshes it only when requested", async () => {
	await call("providers:list");
	await call("providers:list");
	expect(fake.rpc).toHaveBeenCalledOnce();
	expect(fake.run).toHaveBeenCalledTimes(2);
	await call("providers:list", true);
	expect(fake.rpc).toHaveBeenCalledTimes(2);
	expect(fake.run).toHaveBeenCalledTimes(4);
	expect(fake.rpc.mock.calls.every(([cwd]) => cwd === "/tmp")).toBe(true);
	expect(fake.run.mock.calls.every(([, options]) => options.cwd === "/tmp")).toBe(true);
});


describe("stored accounts without usage reporting", () => {
	it("offers sign-out for a stored API key, uses omp's existing logout path, and refreshes the signed-out state", async () => {
		let signedIn = true;
		fake.rpc.mockImplementation(async () => ({ providers: [{ id: "scaleway", name: "Scaleway", authenticated: signedIn }] }));
		fake.rpcs.mockImplementation(async () => [{ accounts: signedIn ? [{ provider: "scaleway", type: "api_key", credentialId: 7, label: "API key #7" }] : [] }]);
		fake.run.mockImplementation(async (args: string[]) => {
			if (args[0] === "auth-broker") signedIn = false;
			return { code: 0, stdout: JSON.stringify(args[0] === "models" ? { models: [] } : usage), stderr: "" };
		});
		const before = await call("providers:list") as ProvidersState;
		expect(before.connected).toEqual([expect.objectContaining({
			id: "scaleway", authenticated: true, canSignOut: true, accounts: [], modelCount: 0,
		})]);
		expect(fake.rpcs).toHaveBeenCalledWith("/tmp", [{ type: "get_logout_accounts", params: { providerId: "scaleway" } }], expect.objectContaining({
			flags: ["--no-session", "--no-lsp", "--no-title", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files"],
		}));
		await call("providers:logout", "scaleway", "/selected-project");
		expect(fake.run).toHaveBeenCalledWith(["auth-broker", "logout", "scaleway"], { cwd: "/selected-project", timeoutMs: 30_000 });
		expect(fake.broadcast).toHaveBeenCalledWith("providers:changed", { providerId: "scaleway" });
		const after = await call("providers:list") as ProvidersState;
		expect(after.connected).toEqual([]);
		expect(after.available).toEqual([{ id: "scaleway", name: "Scaleway" }]);
		expect(fake.rpc).toHaveBeenCalledTimes(2);
	});

	it("uses the canonical stored provider for an authenticated alias without creating a duplicate row", async () => {
		fake.rpc.mockResolvedValue({ providers: [
			{ id: "mistral", name: "Mistral", authenticated: true },
			{ id: "mistral-vibe", name: "Mistral Vibe", authenticated: true },
		] });
		fake.rpcs.mockResolvedValue([
			{ accounts: [{ provider: "mistral", credentialId: 1, type: "api_key" }] },
			{ accounts: [{ provider: "mistral", credentialId: 1, type: "api_key" }] },
		]);
		const state = await call("providers:list") as ProvidersState;
		expect(state.connected).toEqual([expect.objectContaining({ id: "mistral", authenticated: true, canSignOut: true })]);
		expect(state.available).toEqual([{ id: "mistral-vibe", name: "Mistral Vibe" }]);
		expect(JSON.stringify(state)).not.toContain("credentialId");
	});

	it("checks model providers without a login method and retains only provider ids from the safe listing", async () => {
		fake.models.mockResolvedValue([{ provider: "legacy-key", kind: "chat", id: "model", selector: "legacy-key/model",
			name: "Model", contextWindow: null, maxTokens: null, reasoning: false, thinking: null, input: ["text"] }]);
		fake.rpcs.mockResolvedValue([{ accounts: [{ provider: "legacy-key", credentialId: 12, label: "API key #12", detail: "stored API key #12" }] }]);
		const state = await call("providers:list") as ProvidersState;
		expect(state.connected).toEqual([expect.objectContaining({ id: "legacy-key", authenticated: true, canSignOut: true, login: null })]);
		expect(JSON.stringify(state)).not.toContain("API key #12");
	});

	it("does not offer sign-out for environment or config authentication without stored accounts", async () => {
		fake.models.mockResolvedValue([{ provider: "scaleway", kind: "chat", id: "model", selector: "scaleway/model",
			name: "Model", contextWindow: null, maxTokens: null, reasoning: false, thinking: null, input: ["text"] }]);
		fake.rpc.mockResolvedValue({ providers: [{ id: "scaleway", name: "Scaleway", authenticated: true }] });
		fake.rpcs.mockResolvedValue([{ accounts: [] }]);
		const state = await call("providers:list") as ProvidersState;
		expect(state.connected).toEqual([expect.objectContaining({ id: "scaleway", authenticated: true, canSignOut: false })]);
	});

	it.each(["unsupported", "different-shape"] as const)("preserves usage-backed sign-out when older omp has an %s logout listing", async mode => {
		fake.usage.mockResolvedValue({ ...usage, accountsWithoutUsage: [{ provider: "openai-codex" }] });
		fake.rpc.mockResolvedValue({ providers: [{ id: "legacy", name: "Legacy", authenticated: true }] });
		if (mode === "unsupported") fake.rpcs.mockRejectedValue(new Error("Unknown command: get_logout_accounts"));
		else fake.rpcs.mockResolvedValue([{ accounts: null }]);
		const state = await call("providers:list") as ProvidersState;
		expect(state.connected).toEqual([expect.objectContaining({ id: "openai-codex", canSignOut: true })]);
		expect(state.available).toEqual([{ id: "legacy", name: "Legacy" }]);
	});

	it("does not query stored accounts when usage already establishes the provider", async () => {
		fake.usage.mockResolvedValue({ ...usage, accountsWithoutUsage: [{ provider: "scaleway" }] });
		fake.rpc.mockResolvedValue({ providers: [{ id: "scaleway", name: "Scaleway", authenticated: true }] });
		await call("providers:list");
		expect(fake.rpcs).not.toHaveBeenCalled();
	});
});

describe("sign-in transfer", () => {
	const secretFixture = '{"version":1,"credentials":[{"provider":"test","credential":{"type":"api_key","key":"fixture-only"}}]}\n';
	it("writes export stdout privately in main, replacing a symlink without modifying its target", async () => {
		const root = await mkdtemp(join(tmpdir(), "visual-omp-auth-test-")); temporary.push(root);
		const selected = join(root, "export.json"); const original = join(root, "original.json");
		await writeFile(original, "keep this");
		if (process.platform === "win32") await writeFile(selected, "replace this");
		else await symlink(original, selected);
		fake.save.mockResolvedValue({ canceled: false, filePath: selected });
		fake.run.mockResolvedValue({ code: 0, stdout: secretFixture, stderr: "warning: fixture output" });
		await expect(call("providers:export")).resolves.toBe(true);
		expect(fake.run).toHaveBeenCalledWith(["auth", "export"], { cwd: "/tmp" });
		expect(await readFile(selected, "utf8")).toBe(secretFixture);
		expect(await readFile(original, "utf8")).toBe("keep this");
		if (process.platform !== "win32") expect((await stat(selected)).mode & 0o777).toBe(0o600);
		expect((await readdir(root)).sort()).toEqual(["export.json", "original.json"]);
	});

	it("passes only the chosen import path to omp, then invalidates provider and model caches", async () => {
		fake.open.mockResolvedValue({ canceled: false, filePaths: ["/private/sign ins.json"] });
		fake.run.mockResolvedValue({ code: 0, stdout: "", stderr: "Imported fixture sign-in." });
		await expect(call("providers:import")).resolves.toBe(true);
		expect(fake.run).toHaveBeenCalledWith(["auth", "import", "/private/sign ins.json"], { cwd: "/tmp" });
		expect(fake.changed).toHaveBeenCalledOnce();
		expect(fake.broadcast).toHaveBeenCalledWith("providers:changed", { providerId: null });
	});

	it("does not invoke omp after either file picker is cancelled", async () => {
		await expect(call("providers:export")).resolves.toBe(false);
		await expect(call("providers:import")).resolves.toBe(false);
		expect(fake.run).not.toHaveBeenCalled();
	});

	it("reports failure by exit code without exposing either credential stream", async () => {
		fake.save.mockResolvedValue({ canceled: false, filePath: "/private/never-written.json" });
		fake.open.mockResolvedValue({ canceled: false, filePaths: ["/private/import.json"] });
		fake.run.mockResolvedValue({ code: 1, stdout: secretFixture, stderr: secretFixture });
		await expect(call("providers:export")).rejects.toThrow(/^omp could not export sign-ins \(exit code 1\)\.$/);
		await expect(call("providers:import")).rejects.toThrow(/^omp could not import sign-ins \(exit code 1\)\.$/);
		expect(fake.changed).not.toHaveBeenCalled();
	});
});
