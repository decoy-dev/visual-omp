import { describe, expect, it, vi } from "vitest";
import { posix } from "node:path";
import { NATIVE_EXTENSION_SOURCE } from "./native-extension";

it("keeps mode requests and location reports working when a terminal variable is broken", async () => {
	const handlers = new Map<string, (event: unknown, context?: unknown) => Promise<void>>();
	const sent: { url: string; body?: string }[] = [];
	let queued = [{ id: "mode-request", request: { mode: "vibe", action: "enter" } }];
	const modes = { plan: { status: "inactive" }, vibe: { status: "inactive" }, goal: { status: "inactive" }, loop: { status: "inactive" } };
	const theme = { getAllThemeColorHexes: () => ["#ffffff"], getBgHex: () => "#101010", getColorHex: () => "#ffffff" };
	const set = vi.fn(async () => ({ ok: true, changed: true, state: modes }));
	const context = { agent: { kind: "main" }, ui: { theme, getTheme: async () => theme }, sessionModes: { getState: () => modes, set }, sessionManager: { getCwd: () => "/correct/project", getSessionFile: () => "/session.jsonl", getSessionId: () => "main-session" } };
	const fetch = async (url: string, options?: { body: string }) => { sent.push({ url, body: options?.body }); return { ok: true, json: async () => { const result = queued; queued = []; return result; } }; };
	const body = NATIVE_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace("export default function", "return function");
	const factory = new Function("process", "fetch", "setTimeout", "clearTimeout", "loadThemeJson", "getCurrentThemeName", "resolveVarRefs", "ansi256ToHex", "existsSync", "homedir", "join", body)(
		{ env: { VOMP_NATIVE_BRIDGE: "http://127.0.0.1:1/token" }, platform: "darwin" }, fetch, () => 1, () => undefined,
		async () => ({ terminal: { background: "missing-variable" } }), () => "broken-terminal",
		() => { throw new Error("Variable reference not found: missing-variable"); }, () => "#000000", () => false, () => "/tmp/omp-1814/agent-HostParity/home", posix.join,
	);
	factory({ on: (name: string, handler: (event: unknown, context?: unknown) => Promise<void>) => handlers.set(name, handler), pi: { getAgentDir: () => "/tmp/omp-1814/agent-HostParity", discoverSlashCommands: async () => [] } });
	await handlers.get("session_start")!({}, context);
	expect(set).toHaveBeenCalledWith({ mode: "vibe", action: "enter" });
	const published = JSON.parse(sent.find(item => item.url.endsWith("/snapshot"))!.body!);
	expect(published.location.cwd).toBe("/correct/project");
	expect(published.modes).toEqual(modes);
	expect(published.theme).toMatchObject({ name: null, background: "#101010", foreground: "#ffffff" });
	expect(sent.some(item => item.url.endsWith("/result/mode-request"))).toBe(true);
});
