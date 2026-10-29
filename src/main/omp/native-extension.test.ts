import { describe, expect, it, vi } from "vitest";
import { posix } from "node:path";
import { NATIVE_EXTENSION_SOURCE } from "./native-extension";

interface CommandFixture {
	files?: { name: string; side?: boolean }[];
	shadowed?: string[];
	requests?: { id: string; kind: string }[];
}
// Exercise generated code with the public SDK exports injected; runtime integration uses the isolated binary fixture.
function harness(options: CommandFixture = {}) {
	const env: Record<string, string> = { VOMP_NATIVE_BRIDGE: "http://127.0.0.1:1234/token" };
	const requests: { url: string; body?: string }[] = [];
	const fetch = vi.fn(async (url: string, request?: { body: string }) => {
		requests.push({ url, body: request?.body });
		return { ok: true, json: async () => url.endsWith("/requests") ? options.requests ?? [] : [] };
	});
	const theme = { getAllThemeColorHexes: () => ["#ffffff"], getBgHex: () => "#000000", getColorHex: () => "#ffffff" };
	const modes = { plan: { status: "inactive" }, vibe: { status: "inactive" }, goal: { status: "inactive" }, loop: { status: "inactive" } };
	const context = { agent: { kind: "main" }, ui: { theme, getTheme: async () => theme }, sessionModes: { getState: () => modes, set: vi.fn() }, sessionManager: { getCwd: () => "/project", getSessionFile: () => "/session.jsonl", getSessionId: () => "session" } };
	const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<void>>();
	const discover = vi.fn(async (_options: { cwd: string }) => options.files ?? []);
	const body = NATIVE_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace("export default function", "return function");
	const factory = new Function("process", "fetch", "setTimeout", "clearTimeout", "loadThemeJson", "getCurrentThemeName", "resolveVarRefs", "ansi256ToHex", "existsSync", "homedir", "join", "discoverSlashCommands", body)(
		{ env, platform: "darwin" }, fetch, () => 1, () => undefined,
		async () => ({ vars: { background: "#123456" }, terminal: { background: "background", foreground: 255, ansi: Array(16).fill("#abcdef") } }),
		() => "custom", (value: string | number, vars: Record<string, string>) => vars[value] ?? value, () => "#eeeeee", () => false, () => "/tmp/omp-1814/agent-HostParity/home", posix.join, discover,
	);
	factory({
		pi: { getAgentDir: () => "/tmp/omp-1814/agent-HostParity" },
		on: (name: string, handler: (event: unknown, ctx?: unknown) => Promise<void>) => handlers.set(name, handler),
		getCommands: () => (options.shadowed ?? []).map(name => ({ name })),
	});
	return { env, requests, context, handlers, discover };
}

describe("hosted extension lifecycle", () => {
	it("reads named compiled/custom theme JSON, scrubs the bridge from tool env and restores it only for shutdown/restart", async () => {
		const test = harness();
		expect(test.env.VOMP_NATIVE_BRIDGE).toBeUndefined();
		await test.handlers.get("session_start")!({}, test.context);
		const snapshot = JSON.parse(test.requests.find(item => item.url.endsWith("/snapshot"))!.body!);
		expect(snapshot.theme).toMatchObject({ name: "custom", terminal: { background: "#123456", foreground: "#eeeeee", ansi: Array(16).fill("#abcdef") } });
		expect(snapshot.location.cwd).toBe("/project");
		await test.handlers.get("session_shutdown")!({});
		expect(test.env.VOMP_NATIVE_BRIDGE).toBe("http://127.0.0.1:1234/token");
		await test.handlers.get("session_start")!({}, test.context);
		expect(test.env.VOMP_NATIVE_BRIDGE).toBeUndefined();
	});
	it("never reports helper modes or restores its bridge into a helper environment", async () => {
		const test = harness();
		await test.handlers.get("session_start")!({}, { ...test.context, agent: { kind: "sub" } });
		await test.handlers.get("mode_changed")!({}, { ...test.context, agent: { kind: "sub" } });
		await test.handlers.get("session_shutdown")!({});
		expect(test.requests).toEqual([]);
		expect(test.env.VOMP_NATIVE_BRIDGE).toBeUndefined();
	});
});

describe("effective file-side commands", () => {
	it("asks omp's SDK on demand and preserves bare names and namespace aliases from enabled sources", async () => {
		const test = harness({ files: [{ name: "user-side", side: true }, { name: "nested", side: true }, { name: "folder:nested", side: true }, { name: "normal", side: false }], requests: [{ id: "commands", kind: "sideCommands" }] });
		await test.handlers.get("session_start")!({}, test.context);
		expect(test.discover).toHaveBeenCalledExactlyOnceWith({ cwd: "/project" });
		expect(JSON.parse(test.requests.find(item => item.url.endsWith("/commands/commands"))!.body!)).toEqual({ commands: ["user-side", "nested", "folder:nested"] });
	});
	it("excludes extension, custom and skill commands that take precedence over file metadata", async () => {
		const test = harness({ files: [{ name: "extension", side: true }, { name: "custom", side: true }, { name: "skill:example", side: true }, { name: "file", side: true }], shadowed: ["extension", "custom", "skill:example"], requests: [{ id: "commands", kind: "sideCommands" }] });
		await test.handlers.get("session_start")!({}, test.context);
		expect(JSON.parse(test.requests.find(item => item.url.endsWith("/commands/commands"))!.body!)).toEqual({ commands: ["file"] });
	});
});
