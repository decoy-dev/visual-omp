import { describe, expect, it, vi } from "vitest";
import { NATIVE_EXTENSION_SOURCE } from "./native-extension";

function harness() {
	const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
	const requests: { url: string; body: unknown }[] = [];
	let queued: { kind: string; id: string }[] = [{ kind: "sessionAccounts", id: "read" }];
	const fetch = vi.fn(async (url: string, options?: { body?: string }) => {
		if (options?.body) requests.push({ url, body: JSON.parse(options.body) });
		return { ok: true, headers: { get: () => "epoch" }, json: async () => { const result = queued; queued = []; return result; } };
	});
	const theme = { getAllThemeColorHexes: () => ["#ffffff"], getBgHex: () => "#000000", getColorHex: () => "#ffffff", symbol: () => "IMAGE" };
	const accounts = vi.fn(() => [{ credentialId: 7, email: "first@example.com", active: true, access: "secret", refresh: "secret" }]);
	const reload = vi.fn().mockResolvedValue(undefined);
	const context = { agent: { kind: "main" }, model: { provider: "anthropic" }, modelRegistry: { authStorage: { credentials: { reload }, oauth: { accounts } } }, ui: { theme, getTheme: async () => theme }, sessionManager: { getCwd: () => "/project", getSessionFile: () => "/session.jsonl", getSessionId: () => "session" } };
	const body = NATIVE_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace("export default function", "return function");
	const factory = new Function("process", "fetch", "setTimeout", "clearTimeout", "loadThemeJson", "getCurrentThemeName", "resolveVarRefs", "ansi256ToHex", "existsSync", "homedir", "join", "discoverSlashCommands", "ompSdk", body)(
		{ env: { VOMP_NATIVE_BRIDGE: "http://127.0.0.1:1234/token" }, platform: "darwin" }, fetch, () => 1, () => {},
		async () => ({}), () => "theme", (value: unknown) => value, () => "#ffffff", () => false, () => "/home", (...parts: string[]) => parts.join("/"), async () => [], { VERSION: "18.17.0" },
	);
	factory({ on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, handler), pi: { getAgentDir: () => "/scratch/agent" } });
	return { context, handlers, requests, accounts, reload };
}

describe("generated extension account API", () => {
	it("uses the namespaced omp 18.15/18.16 SDK and reloads only for an explicit read", async () => {
		const test = harness();
		await test.handlers.get("session_start")!({}, test.context);
		expect(test.requests.find(request => request.url.endsWith("/snapshot"))?.body).toMatchObject({ ompVersion: "18.17.0" });
		expect(test.reload).toHaveBeenCalledOnce();
		expect(test.accounts).toHaveBeenCalledWith("anthropic", "session");
		expect(test.requests.find(request => request.url.endsWith("/accounts/read"))?.body).toEqual({ provider: "anthropic", sessionId: "session", accounts: [{ credentialId: 7, label: "first@example.com", active: true }] });
		expect(JSON.stringify(test.requests)).not.toContain("secret");
	});
	it("reports unreadable state after a failed reload rather than presenting a cached account list as fresh", async () => {
		const test = harness(); test.reload.mockRejectedValue(new Error("store unavailable"));
		await test.handlers.get("session_start")!({}, test.context);
		expect(test.requests.find(request => request.url.endsWith("/accounts/read"))?.body).toBeNull();
	});
});
