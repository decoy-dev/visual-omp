import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProvidersState, StoredProviderAccount } from "@shared/contracts/providers";
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
const storedAccount = (patch: Partial<StoredProviderAccount> = {}): StoredProviderAccount => ({
	provider: "scaleway", credentialId: 7, type: "api_key", label: "API key #7", detail: "stored API key #7", active: false, ...patch,
});
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
	expect(state.connected[0]).toMatchObject({ modelCount: 1, authenticated: true, storedAccounts: [] });
	expect(state.available.map(method => method.id)).toEqual(["openai-codex-device", "future-alias"]);
});

it("keeps a distinct provider when its own accounts or disabled credentials establish it", async () => {
	fake.usage.mockResolvedValue({ ...usage, accountsWithoutUsage: [{ provider: "own-provider", email: "me@example.com" }], disabledCredentials: [{ provider: "disabled-provider", cause: "expired" }] });
	const state = await call("providers:list") as ProvidersState;
	expect(new Set(state.connected.map(provider => provider.id))).toEqual(new Set(["own-provider", "disabled-provider"]));
	expect(state.connected.find(provider => provider.id === "own-provider")).toMatchObject({ name: "own-provider", login: null, storedAccounts: [] });
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


describe("individual stored accounts", () => {
	it("removes one API key through omp RPC, preserving its sibling and refreshing status", async () => {
		const first = storedAccount();
		const sibling = storedAccount({ credentialId: 8, label: "API key #8", detail: "stored API key #8" });
		let accounts = [first, sibling];
		const removed: unknown[] = [];
		fake.rpc.mockImplementation(async () => ({ providers: [{ id: "scaleway", name: "Scaleway", authenticated: accounts.length > 0 }] }));
		fake.rpcs.mockImplementation(async (_cwd: string, requests: { type: string; params: Record<string, unknown>; validate?: (data: unknown) => void }[]) => {
			const results = [];
			for (const request of requests) {
				if (request.type === "get_logout_accounts") {
					const data = { accounts };
					request.validate?.(data);
					results.push(data);
				} else {
					removed.push(request.params);
					accounts = accounts.filter(account => account.credentialId !== request.params.credentialId);
					results.push({ remainingSource: "stored API key" });
				}
			}
			return results;
		});
		const before = await call("providers:list") as ProvidersState;
		expect(before.connected[0]).toMatchObject({ id: "scaleway", authenticated: true, storedAccounts: [first, sibling] });
		await call("providers:logout", first);
		expect(removed).toEqual([{ providerId: "scaleway", credentialId: 7 }]);
		expect(fake.rpcs).toHaveBeenLastCalledWith("/tmp", [
			{ type: "get_logout_accounts", params: { providerId: "scaleway" }, validate: expect.any(Function) },
			{ type: "logout", params: { providerId: "scaleway", credentialId: 7 } },
		], expect.objectContaining({ flags: ["--no-session", "--no-lsp", "--no-title", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files"] }));
		expect(fake.broadcast).toHaveBeenCalledWith("providers:changed", { providerId: "scaleway" });
		const after = await call("providers:list") as ProvidersState;
		expect(after.connected[0]).toMatchObject({ authenticated: true, storedAccounts: [sibling] });
		expect(fake.run.mock.calls.every(([args]) => args[0] !== "auth-broker")).toBe(true);
		await call("providers:logout", sibling);
		const empty = await call("providers:list") as ProvidersState;
		expect(empty.connected).toEqual([]);
		expect(empty.available).toEqual([{ id: "scaleway", name: "Scaleway" }]);
	});

	it("lists organization-qualified identities and multiple keys without merging sibling accounts", async () => {
		const accounts = [
			storedAccount({ type: "oauth", credentialId: 1, label: "me@example.com (Personal)", detail: "account personal · oauth #1" }),
			storedAccount({ type: "oauth", credentialId: 2, label: "me@example.com (Team)", detail: "account team · oauth #2" }),
			storedAccount(),
			storedAccount({ credentialId: 8, label: "API key #8", detail: "stored API key #8" }),
		];
		fake.usage.mockResolvedValue({ ...usage, accountsWithoutUsage: [{ provider: "scaleway", email: "me@example.com" }] });
		fake.rpcs.mockResolvedValue([{ accounts }]);
		const state = await call("providers:list") as ProvidersState;
		expect(state.connected[0]!.storedAccounts).toEqual(accounts);
		expect(fake.rpcs).toHaveBeenCalledWith("/tmp", [{ type: "get_logout_accounts", params: { providerId: "scaleway" } }], expect.any(Object));
	});

	it.each(["missing", "changed", "wrong-provider", "duplicate"] as const)("refuses a %s target before sending logout", async mode => {
		const target = storedAccount();
		const listed = mode === "missing" ? []
			: mode === "changed" ? [{ ...target, label: "Different account" }]
				: mode === "wrong-provider" ? [{ ...target, provider: "another" }]
					: [target, target];
		const sent: string[] = [];
		fake.rpcs.mockImplementation(async (_cwd: string, requests: { type: string; validate?: (data: unknown) => void }[]) => {
			for (const request of requests) {
				sent.push(request.type);
				request.validate?.({ accounts: listed });
			}
			return [];
		});
		await expect(call("providers:logout", target)).rejects.toThrow("The selected account changed or is no longer stored. Check providers again.");
		expect(sent).toEqual(["get_logout_accounts"]);
	});

	it.each([undefined, "scaleway", { ...storedAccount(), credentialId: -1 }, { ...storedAccount(), credentialId: Number.MAX_SAFE_INTEGER + 1 }, { ...storedAccount(), provider: "../bad" }])("rejects an invalid account without RPC", async target => {
		await expect(call("providers:logout", target)).rejects.toThrow("The selected account is invalid.");
		expect(fake.rpcs).not.toHaveBeenCalled();
	});

	it("uses canonical stored providers for aliases and strips all non-metadata fields from IPC", async () => {
		fake.rpc.mockResolvedValue({ providers: [
			{ id: "mistral", name: "Mistral", authenticated: true },
			{ id: "mistral-vibe", name: "Mistral Vibe", authenticated: true },
		] });
		const safe = storedAccount({ provider: "mistral" });
		const account = { ...safe, key: "secret-key-fixture", access: "secret-access-fixture", refresh: "secret-refresh-fixture", credential: { key: "secret-nested-fixture" } };
		fake.rpcs.mockResolvedValue([{ accounts: [account] }, { accounts: [account] }]);
		const state = await call("providers:list") as ProvidersState;
		expect(state.connected).toEqual([expect.objectContaining({ id: "mistral", authenticated: true, storedAccounts: [safe] })]);
		expect(state.available).toEqual([{ id: "mistral-vibe", name: "Mistral Vibe" }]);
		expect(JSON.stringify(state)).not.toContain("secret-");
	});

	it("lists a stored API key for a model provider without a login method", async () => {
		fake.models.mockResolvedValue([{ provider: "legacy-key", kind: "chat", id: "model", selector: "legacy-key/model",
			name: "Model", contextWindow: null, maxTokens: null, reasoning: false, thinking: null, input: ["text"] }]);
		const account = storedAccount({ provider: "legacy-key" });
		fake.rpcs.mockResolvedValue([{ accounts: [account] }]);
		const state = await call("providers:list") as ProvidersState;
		expect(state.connected).toEqual([expect.objectContaining({ id: "legacy-key", authenticated: true, storedAccounts: [account], login: null })]);
	});

	it("suppresses credential diagnostics from RPC errors and invalidates after an attempted removal", async () => {
		const target = storedAccount();
		fake.rpcs.mockImplementation(async (_cwd: string, requests: { validate?: (data: unknown) => void }[]) => {
			requests[0]!.validate?.({ accounts: [target] });
			throw new Error("secret-refresh-fixture");
		});
		await expect(call("providers:logout", target)).rejects.toThrow(/^omp could not sign out of the selected account\. Check providers and try again\.$/);
		expect(fake.broadcast).toHaveBeenCalledWith("providers:changed", { providerId: "scaleway" });
	});

	it("does not offer removal for environment or config authentication without stored accounts", async () => {
		fake.models.mockResolvedValue([{ provider: "scaleway", kind: "chat", id: "model", selector: "scaleway/model",
			name: "Model", contextWindow: null, maxTokens: null, reasoning: false, thinking: null, input: ["text"] }]);
		fake.rpc.mockResolvedValue({ providers: [{ id: "scaleway", name: "Scaleway", authenticated: true }] });
		fake.rpcs.mockResolvedValue([{ accounts: [] }]);
		const state = await call("providers:list") as ProvidersState;
		expect(state.connected).toEqual([expect.objectContaining({ id: "scaleway", authenticated: true, storedAccounts: [] })]);
	});

	it.each(["unsupported", "different-shape"] as const)("preserves auth status without unsafe sign-out when the listing is %s", async mode => {
		fake.usage.mockResolvedValue({ ...usage, accountsWithoutUsage: [{ provider: "openai-codex" }] });
		if (mode === "unsupported") fake.rpcs.mockRejectedValue(new Error("Unknown command: get_logout_accounts"));
		else fake.rpcs.mockResolvedValue([{ accounts: null }]);
		const state = await call("providers:list") as ProvidersState;
		expect(state.connected).toEqual([expect.objectContaining({ id: "openai-codex", accounts: [expect.any(Object)], storedAccounts: [] })]);
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
