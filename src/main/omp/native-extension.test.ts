import { describe, expect, it, vi } from "vitest";
import { posix } from "node:path";
import { NATIVE_EXTENSION_SOURCE } from "./native-extension";

interface CommandFixture {
	files?: { name: string; side?: boolean }[];
	shadowed?: string[];
	requests?: { id: string; kind: string }[];
	jobs?: Record<string, unknown>[];
	jobsEpoch?: string;
}
// Exercise generated code with the public SDK exports injected; runtime integration uses the isolated binary fixture.
function harness(options: CommandFixture = {}) {
	const env: Record<string, string> = { VOMP_NATIVE_BRIDGE: "http://127.0.0.1:1234/token" };
	const requests: { url: string; body?: string }[] = [];
	const timers: (() => Promise<void>)[] = [];
	const fetch = vi.fn(async (url: string, request?: { body: string }) => {
		requests.push({ url, body: request?.body });
		return { ok: true, headers: { get: (_name: string): string | null => options.jobsEpoch ?? null }, json: async (): Promise<unknown[]> => url.endsWith("/requests") ? options.requests ?? [] : [] };
	});
	const theme = { getAllThemeColorHexes: () => ["#ffffff"], getBgHex: () => "#000000", getColorHex: () => "#ffffff" };
	const modes = { plan: { status: "inactive" }, vibe: { status: "inactive" }, goal: { status: "inactive" }, loop: { status: "inactive" } };
	const context = { agent: { kind: "main" }, ui: { theme, getTheme: async () => theme }, sessionModes: { getState: () => modes, set: vi.fn() }, sessionManager: { getCwd: () => "/project", getSessionFile: () => "/session.jsonl", getSessionId: () => "session" }, getAsyncJobSnapshot: vi.fn(() => ({ running: options.jobs ?? [], recent: [{ id: "finished" }] })) };
	const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<void>>();
	const discover = vi.fn(async (_options: { cwd: string }) => options.files ?? []);
	const body = NATIVE_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace("export default function", "return function");
	const factory = new Function("process", "fetch", "setTimeout", "clearTimeout", "loadThemeJson", "getCurrentThemeName", "resolveVarRefs", "ansi256ToHex", "existsSync", "homedir", "join", "discoverSlashCommands", body)(
		{ env, platform: "darwin" }, fetch, (callback: () => Promise<void>) => { timers.push(callback); return timers.length; }, () => undefined,
		async () => ({ vars: { background: "#123456" }, terminal: { background: "background", foreground: 255, ansi: Array(16).fill("#abcdef") } }),
		() => "custom", (value: string | number, vars: Record<string, string>) => vars[value] ?? value, () => "#eeeeee", () => false, () => "/tmp/omp-1814/agent-HostParity/home", posix.join, discover,
	);
	factory({
		pi: { getAgentDir: () => "/tmp/omp-1814/agent-HostParity" },
		on: (name: string, handler: (event: unknown, ctx?: unknown) => Promise<void>) => handlers.set(name, handler),
		getCommands: () => (options.shadowed ?? []).map(name => ({ name })),
	});
	return { env, requests, context, handlers, discover, fetch, tick: async () => { await timers.shift()?.(); } };
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
	it("publishes running purposes and captions on periodic ticks without shipping output or unchanged snapshots", async () => {
		const job = { id: "bg_1", intent: "Building the installer", caption: "Compiles the desktop bundle", command: "make", output: "private output", durationMs: 1 };
		const test = harness({ jobs: [job] });
		await test.handlers.get("session_start")!({}, test.context);
		const snapshots = () => test.requests.filter(item => item.url.endsWith("/snapshot"));
		expect(JSON.parse(snapshots()[0]!.body!).asyncJobs).toEqual([{ id: "bg_1", intent: job.intent, caption: job.caption }]);
		job.durationMs++;
		await test.tick();
		expect(snapshots()).toHaveLength(1);
		job.caption = "Packages the signed desktop bundle";
		await test.tick();
		expect(snapshots()).toHaveLength(2);
		expect(JSON.parse(snapshots()[1]!.body!).asyncJobs[0].caption).toBe(job.caption);
		expect(test.context.getAsyncJobSnapshot).toHaveBeenCalledTimes(3);
	});
	it("bounds metadata and encoded payloads so large job lists cannot block mode and location reports", async () => {
		const test = harness({ jobs: Array.from({ length: 1000 }, (_, index) => ({ id: `bg_${index}`, intent: "\u0000".repeat(10000), caption: "\u0000".repeat(10000) })) });
		await test.handlers.get("session_start")!({}, test.context);
		const encoded = test.requests.find(item => item.url.endsWith("/snapshot"))!.body!;
		const snapshot = JSON.parse(encoded);
		expect(encoded.length).toBeLessThan(65536);
		expect(JSON.stringify(snapshot.asyncJobs).length).toBeLessThanOrEqual(24000);
		expect(snapshot.asyncJobs.length).toBeGreaterThan(0);
		expect(snapshot.asyncJobs.length).toBeLessThanOrEqual(100);
		expect(snapshot.asyncJobs[0].intent).toHaveLength(2048);
		expect(snapshot.asyncJobs[0].caption).toHaveLength(1024);
		expect(snapshot.location.cwd).toBe("/project");
		expect(snapshot.modes).toEqual(test.context.sessionModes.getState());
	});
	it("caps numerous small summaries and treats older SDK data without captions as empty", async () => {
		const test = harness({ jobs: Array.from({ length: 1000 }, (_, index) => ({ id: `bg_${index}` })) });
		await test.handlers.get("session_start")!({}, test.context);
		const snapshot = JSON.parse(test.requests.find(item => item.url.endsWith("/snapshot"))!.body!);
		expect(snapshot.asyncJobs).toHaveLength(100);
		expect(snapshot.asyncJobs[0]).toEqual({ id: "bg_0", intent: null, caption: null });
	});
	it("refreshes unchanged metadata after the existing request poll learns a new bridge epoch", async () => {
		const options = { jobsEpoch: "first", jobs: [{ id: "bg_1", caption: "Compiles the bundle" }] };
		const test = harness(options);
		await test.handlers.get("session_start")!({}, test.context);
		await test.tick();
		options.jobsEpoch = "next";
		await test.tick();
		await test.tick();
		const snapshots = test.requests.filter(item => item.url.endsWith("/snapshot")).map(item => JSON.parse(item.body!));
		expect(snapshots.map(snapshot => snapshot.asyncJobsEpoch)).toEqual([null, "first", "next"]);
		expect(snapshots[2].asyncJobs).toEqual([{ id: "bg_1", intent: null, caption: "Compiles the bundle" }]);
	});
	it("ignores an older context's request response after a fresh session starts", async () => {
		const test = harness({ jobsEpoch: "current" });
		const fetch = test.fetch.getMockImplementation()!;
		const entered = Promise.withResolvers<void>();
		const delayed = Promise.withResolvers<void>();
		let held = false;
		test.fetch.mockImplementation(async (url, request) => {
			if (url.endsWith("/requests") && !held) {
				held = true; entered.resolve(); await delayed.promise;
				return { ok: true, headers: { get: () => "old" }, json: async () => [] };
			}
			return fetch(url, request);
		});
		const previous = test.handlers.get("session_start")!({}, test.context);
		await entered.promise;
		await test.handlers.get("session_start")!({}, { ...test.context });
		delayed.resolve(); await previous;
		await test.tick();
		const snapshots = test.requests.filter(item => item.url.endsWith("/snapshot")).map(item => JSON.parse(item.body!));
		expect(snapshots.at(-1).asyncJobsEpoch).toBe("current");
	});
	it("does not let a delayed shutdown clear a newer session's context", async () => {
		const test = harness({ jobsEpoch: "current" });
		await test.handlers.get("session_start")!({}, test.context);
		const fetch = test.fetch.getMockImplementation()!;
		const delayed = Promise.withResolvers<void>();
		test.fetch.mockImplementationOnce(async (url, request) => { await delayed.promise; return fetch(url, request); });
		const shutdown = test.handlers.get("session_shutdown")!({});
		const nextContext = { ...test.context, sessionManager: { ...test.context.sessionManager, getCwd: () => "/next" } };
		await test.handlers.get("session_start")!({}, nextContext);
		delayed.resolve(); await shutdown;
		await test.tick();
		const snapshots = test.requests.filter(item => item.url.endsWith("/snapshot")).map(item => JSON.parse(item.body!));
		expect(snapshots.at(-1)).toMatchObject({ location: { cwd: "/next" }, asyncJobsEpoch: "current" });
		expect(snapshots.at(-1).shutdown).toBeUndefined();
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
