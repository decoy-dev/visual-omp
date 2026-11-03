import { describe, expect, it, vi } from "vitest";
import { posix } from "node:path";
import { NATIVE_EXTENSION_SOURCE } from "./native-extension";

interface CommandFixture {
	files?: { name: string; side?: boolean }[];
	shadowed?: string[];
	requests?: { id: string; kind: string; prompt?: { id: string; sessionId: string; text: string; images?: number; classicEditor?: { expected: string } }; epoch?: string }[];
	jobs?: Record<string, unknown>[];
	jobsEpoch?: string;
	delivery?: { queued: number; delivering: boolean };
	streaming?: boolean;
	pendingMessages?: boolean;
	shutdownUnavailable?: boolean;
}
// Exercise generated code with the public SDK exports injected; runtime integration uses the isolated binary fixture.
function harness(options: CommandFixture = {}) {
	const env: Record<string, string> = { VOMP_NATIVE_BRIDGE: "http://127.0.0.1:1234/token" };
	const requests: { url: string; body?: string }[] = [];
	const timers = new Map<number, { callback: () => void | Promise<void>; delay: number }>();
	let nextTimer = 0;
	const fetch = vi.fn(async (url: string, request?: { body: string }) => {
		requests.push({ url, body: request?.body });
		return { ok: true, headers: { get: (_name: string): string | null => options.jobsEpoch ?? null }, json: async (): Promise<unknown[]> => url.endsWith("/requests") ? options.requests ?? [] : [] };
	});
	const theme = { getAllThemeColorHexes: () => ["#ffffff"], getBgHex: () => "#000000", getColorHex: () => "#ffffff", symbol: () => "IMAGE" };
	const modes = { plan: { status: "inactive" }, vibe: { status: "inactive" }, goal: { status: "inactive" }, loop: { status: "inactive" } };
	const shutdown = vi.fn();
	const context = { agent: { kind: "main" }, ui: { theme, getTheme: async () => theme }, shutdown: options.shutdownUnavailable ? undefined : shutdown, sessionModes: { getState: () => modes, set: vi.fn() }, sessionManager: { getCwd: () => "/project", getSessionFile: () => "/session.jsonl", getSessionId: () => "session" }, getAsyncJobSnapshot: vi.fn(() => ({ running: options.jobs ?? [], recent: [{ id: "finished" }], delivery: options.delivery ?? { queued: 0, delivering: false } })), isIdle: () => !options.streaming, hasPendingMessages: () => options.pendingMessages === true };
	const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<void>>();
	const discover = vi.fn(async (_options: { cwd: string }) => options.files ?? []);
	const body = NATIVE_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace("export default function", "return function");
	const factory = new Function("process", "fetch", "setTimeout", "clearTimeout", "loadThemeJson", "getCurrentThemeName", "resolveVarRefs", "ansi256ToHex", "existsSync", "homedir", "join", "discoverSlashCommands", body)(
		{ env, platform: "darwin" }, fetch, (callback: () => void | Promise<void>, delay: number) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }, (id: number) => timers.delete(id),
		async () => ({ vars: { background: "#123456" }, terminal: { background: "background", foreground: 255, ansi: Array(16).fill("#abcdef") } }),
		() => "custom", (value: string | number, vars: Record<string, string>) => vars[value] ?? value, () => "#eeeeee", () => false, () => "/tmp/omp-1814/agent-HostParity/home", posix.join, discover,
	);
	factory({
		pi: { getAgentDir: () => "/tmp/omp-1814/agent-HostParity" },
		on: (name: string, handler: (event: unknown, ctx?: unknown) => Promise<void>) => handlers.set(name, handler),
		getCommands: () => (options.shadowed ?? []).map(name => ({ name })),
	});
	return {
		env, requests, context, shutdown, handlers, discover, fetch,
		tick: async () => {
			const next = [...timers].find(([, timer]) => timer.delay === 250);
			if (next) { timers.delete(next[0]); await next[1].callback(); }
		},
		expirePrompts: async () => {
			for (const [id, timer] of [...timers]) if (timer.delay === 30_000) { timers.delete(id); await timer.callback(); }
		},
	};
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
	it("requests SDK shutdown without touching the contaminated editor or submitting a command", async () => {
		const test = harness({ requests: [{ id: "shutdown", kind: "shutdown" }] });
		await test.handlers.get("session_start")!({}, test.context);
		expect(test.shutdown).toHaveBeenCalledExactlyOnceWith();
		expect(test.context.sessionModes.set).not.toHaveBeenCalled();
		expect(test.requests.filter(item => !item.url.endsWith("/requests") && !item.url.endsWith("/snapshot"))).toEqual([]);
	});
	it("leaves unavailable SDK shutdown to the host's explicit native stop decision", async () => {
		const test = harness({ requests: [{ id: "shutdown", kind: "shutdown" }], shutdownUnavailable: true });
		await test.handlers.get("session_start")!({}, test.context);
		expect(test.shutdown).not.toHaveBeenCalled();
		expect(test.context.sessionModes.set).not.toHaveBeenCalled();
		expect(test.requests.filter(item => !item.url.endsWith("/requests") && !item.url.endsWith("/snapshot"))).toEqual([]);
	});
	it("retains the wait for remaining jobs and delivery handoffs, then reports quiet completion", async () => {
		const options: CommandFixture = { jobs: [{ id: "bg_1" }, { id: "bg_2" }], requests: [{ id: "wait", kind: "asyncWork" }], delivery: { queued: 0, delivering: false } };
		const test = harness(options);
		await test.handlers.get("session_start")!({}, test.context);
		options.jobs!.shift();
		await test.tick();
		options.jobs = [];
		options.delivery = { queued: 1, delivering: true };
		await test.tick();
		options.delivery = { queued: 0, delivering: false };
		await test.tick();
		expect(test.requests.filter(item => item.url.endsWith("/async-work/wait")).map(item => JSON.parse(item.body!).pending)).toEqual([true, true, true, false]);
	});
	it("does not report quiescence while a continuation streams or messages remain queued", async () => {
		const options: CommandFixture = { requests: [{ id: "wait", kind: "asyncWork" }], streaming: true };
		const test = harness(options);
		await test.handlers.get("session_start")!({}, test.context);
		options.streaming = false; options.pendingMessages = true;
		await test.tick();
		options.pendingMessages = false;
		await test.tick();
		expect(test.requests.filter(item => item.url.endsWith("/async-work/wait")).map(item => JSON.parse(item.body!).pending)).toEqual([true, true, false]);
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

describe("exact native prompt observation", () => {
	const watch = (id: string, text = "exact prompt", sessionId = "session", epoch = "current", images?: number) => ({ id, kind: "watchPrompt", prompt: { id, sessionId, text, images }, epoch });
	const input = (text = "exact prompt", source = "interactive") => ({ text, source });
	const states = (test: { requests: { url: string; body?: string }[] }) => test.requests.filter(item => item.url.includes("/prompt/")).map(item => ({ id: item.url.split("/").at(-1), ...JSON.parse(item.body!) }));

	it("registers before confirming armed and observes without handling or awaiting input", async () => {
		const test = harness({ jobsEpoch: "current", requests: [watch("first")] });
		const fetch = test.fetch.getMockImplementation()!;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		test.fetch.mockImplementation(async (url, request) => {
			const response = await fetch(url, request);
			if (url.endsWith("/prompt/first") && JSON.parse(request!.body).state === "armed") { entered.resolve(); await release.promise; }
			return response;
		});
		const starting = test.handlers.get("session_start")!({}, test.context);
		await entered.promise;
		expect(test.handlers.get("input")!(input(), test.context)).toBeUndefined();
		expect(states(test).map(item => item.state)).toEqual(["armed", "input"]);
		release.resolve(); await starting;
		expect(test.context.sessionModes.set).not.toHaveBeenCalled();
	});

	it("requires exact text, session and interactive source and leaves unmatched watches armed", async () => {
		const test = harness({ jobsEpoch: "current", requests: [watch("first")] });
		await test.handlers.get("session_start")!({}, test.context);
		for (const text of ["exact prompt ", "exact", "another prompt", "exact\r\nprompt"]) test.handlers.get("input")!(input(text), test.context);
		test.handlers.get("input")!(input(), { ...test.context, sessionManager: { ...test.context.sessionManager, getSessionId: () => "other" } });
		test.handlers.get("input")!(input("exact prompt", "extension"), test.context);
		test.handlers.get("input")!(input("exact prompt", "rpc"), test.context);
		expect(states(test).map(item => item.state)).toEqual(["armed"]);
		test.handlers.get("input")!(input(), test.context);
		test.handlers.get("input")!(input(), test.context);
		expect(states(test)).toEqual([
			{ id: "first", state: "armed", sessionId: "session", epoch: "current", emptyResume: false },
			{ id: "first", state: "input", sessionId: "session", epoch: "current" },
		]);
	});

	it("takes only the oldest matching watch once per normal input", async () => {
		const test = harness({ jobsEpoch: "current", requests: [watch("first"), watch("unmatched", "other"), watch("second")] });
		await test.handlers.get("session_start")!({}, test.context);
		test.handlers.get("input")!(input(), test.context);
		test.handlers.get("input")!(input(), test.context);
		test.handlers.get("input")!(input(), test.context);
		expect(states(test).filter(item => item.state === "input").map(item => item.id)).toEqual(["first", "second"]);
		test.handlers.get("input")!(input("other"), test.context);
		expect(states(test).filter(item => item.state === "input").map(item => item.id)).toEqual(["first", "second", "unmatched"]);
	});

	it("ignores wrong-session and stale-epoch arms and removes forgotten watches through the request queue", async () => {
		const options: CommandFixture = { jobsEpoch: "current", requests: [watch("wrong-session", "exact prompt", "other"), watch("old", "exact prompt", "session", "old"), watch("forgotten")] };
		const test = harness(options);
		await test.handlers.get("session_start")!({}, test.context);
		expect(states(test).map(item => item.id)).toEqual(["forgotten"]);
		options.requests = [{ id: "forgotten", kind: "forgetPrompt", epoch: "current" }];
		await test.tick();
		test.handlers.get("input")!(input(), test.context);
		expect(states(test).map(item => item.state)).toEqual(["armed"]);
	});

	it("clears observation on generation changes, session switches and shutdown", async () => {
		const options: CommandFixture = { jobsEpoch: "current", requests: [watch("old-generation")] };
		const test = harness(options);
		await test.handlers.get("session_start")!({}, test.context);
		options.jobsEpoch = "next"; options.requests = [];
		await test.tick();
		test.handlers.get("input")!(input(), test.context);
		options.requests = [watch("old-session", "exact prompt", "session", "next")];
		await test.tick();
		options.requests = [];
		await test.handlers.get("session_switch")!({}, { ...test.context });
		test.handlers.get("input")!(input(), test.context);
		options.requests = [watch("shutdown", "exact prompt", "session", "next")];
		await test.tick();
		await test.handlers.get("session_shutdown")!({});
		test.handlers.get("input")!(input(), test.context);
		expect(states(test).map(item => item.state)).toEqual(["armed", "armed", "armed"]);
	});

	it("expires retained text and refuses excessive watch storage", async () => {
		const options: CommandFixture = { jobsEpoch: "current", requests: Array.from({ length: 65 }, (_, index) => watch(String(index))) };
		const test = harness(options);
		await test.handlers.get("session_start")!({}, test.context);
		expect(states(test).filter(item => item.state === "armed")).toHaveLength(64);
		expect(states(test).at(-1)).toMatchObject({ id: "64", state: "error" });
		options.requests = [];
		await test.expirePrompts();
		test.handlers.get("input")!(input(), test.context);
		expect(states(test).filter(item => item.state === "input")).toEqual([]);
	});

	it("does not observe after the bridge refuses its armed confirmation", async () => {
		const test = harness({ jobsEpoch: "current", requests: [watch("refused")] });
		const fetch = test.fetch.getMockImplementation()!;
		test.fetch.mockImplementation(async (url, request) => {
			const response = await fetch(url, request);
			return url.endsWith("/prompt/refused") ? { ...response, ok: false } : response;
		});
		await test.handlers.get("session_start")!({}, test.context);
		test.handlers.get("input")!(input(), test.context);
		expect(states(test).map(item => item.state)).toEqual(["armed"]);
	});

	it("reports empty-resume only for an idle, unqueued shortcut whose public branch has no user message", async () => {
		for (const text of [".", "c", "normal prompt"]) {
			const test = harness({ jobsEpoch: "current", requests: [watch(text, text)] });
			const context = { ...test.context, sessionManager: { ...test.context.sessionManager, getBranch: () => [{ type: "message", message: { role: "assistant" } }, { type: "custom" }] } };
			await test.handlers.get("session_start")!({}, context);
			expect(states(test)[0].emptyResume).toBe(text !== "normal prompt");
		}
		for (const options of [{ streaming: true, pendingMessages: false }, { streaming: false, pendingMessages: true }, { streaming: false, pendingMessages: false }]) {
			const test = harness({ ...options, jobsEpoch: "current", requests: [watch("shortcut", ".")] });
			const context = { ...test.context, sessionManager: { ...test.context.sessionManager, getBranch: () => options.streaming || options.pendingMessages ? [] : [{ type: "message", message: { role: "user" } }] } };
			await test.handlers.get("session_start")!({}, context);
			expect(states(test)[0].emptyResume).toBe(false);
		}
		const unavailable = harness({ jobsEpoch: "current", requests: [watch("shortcut", "c")] });
		await unavailable.handlers.get("session_start")!({}, unavailable.context);
		expect(states(unavailable)[0].emptyResume).toBe(false);
	});

	it("matches exactly owned leading image markers and dimensions while preserving multiline authored text", async () => {
		const authored = "compare these images\nkeep this second line exact";
		for (const prefix of ["[Image #1] [Image #2]", "[Image #1, 640x480]\n[Image #2, 1280x720]", "[Image #1]\n[Image #2, 100x200]"]) {
			const test = harness({ jobsEpoch: "current", requests: [watch("images", authored, "session", "current", 2)] });
			await test.handlers.get("session_start")!({}, test.context);
			const event = { ...input(`${prefix}\n${authored}`), images: [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "image", data: "AQ==", mimeType: "image/png" }] };
			expect(test.handlers.get("input")!(event, test.context)).toBeUndefined();
			test.handlers.get("input")!(event, test.context);
			expect(states(test).filter(item => item.state === "input")).toEqual([{ id: "images", state: "input", sessionId: "session", epoch: "current" }]);
		}
	});

	it("does not strip nonleading, malformed, unowned or out-of-order markers or accept wrong image counts and text", async () => {
		const test = harness({ jobsEpoch: "current", requests: [watch("images", "authored\ntext", "session", "current", 2)] });
		await test.handlers.get("session_start")!({}, test.context);
		const images = [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "image", data: "AQ==", mimeType: "image/png" }];
		for (const text of [
			"[Image #2] [Image #1] authored\ntext",
			"[Image #1] authored\ntext",
			"[Image #1] [Image #2] [Image #3] authored\ntext",
			"intro [Image #1] [Image #2] authored\ntext",
			"[Image #01] [Image #2] authored\ntext",
			"[Video #1] [Image #2] authored\ntext",
			"[Image #1, metadata] [Image #2] authored\ntext",
			"[Image #1, 640X480] [Image #2] authored\ntext",
			"[Image #1] [Image #2] authored text",
			"[Image #1] [Image #2] authored\ntext ",
		]) test.handlers.get("input")!({ ...input(text), images }, test.context);
		for (const wrongImages of [undefined, [], images.slice(0, 1), [...images, images[0]]]) {
			test.handlers.get("input")!({ ...input("[Image #1] [Image #2] authored\ntext"), images: wrongImages }, test.context);
			test.handlers.get("input")!({ ...input("authored\ntext"), images: wrongImages }, test.context);
		}
		test.handlers.get("input")!({ ...input("[Image #1] [Image #2] authored\ntext"), images }, { ...test.context, sessionManager: { ...test.context.sessionManager, getSessionId: () => "other" } });
		expect(states(test).filter(item => item.state === "input")).toEqual([]);
		test.handlers.get("input")!({ ...input("[Image #1] [Image #2] authored\ntext"), images }, test.context);
		expect(states(test).filter(item => item.state === "input")).toHaveLength(1);
	});

	it("never normalizes image prefixes without ownership metadata or removes authored markers", async () => {
		const test = harness({ jobsEpoch: "current", requests: [watch("plain")] });
		await test.handlers.get("session_start")!({}, test.context);
		const images = [{ type: "image", data: "AA==", mimeType: "image/png" }];
		test.handlers.get("input")!({ ...input("[Image #1] exact prompt"), images }, test.context);
		test.handlers.get("input")!({ ...input(), images }, test.context);
		expect(states(test).filter(item => item.state === "input")).toEqual([]);
		test.handlers.get("input")!(input(), test.context);
		expect(states(test).filter(item => item.state === "input")).toHaveLength(1);
		const literal = harness({ jobsEpoch: "current", requests: [watch("literal", "[Image #7] is authored text", "session", "current", 1)] });
		await literal.handlers.get("session_start")!({}, literal.context);
		literal.handlers.get("input")!({ ...input("[Image #1] [Image #7] is authored text"), images }, literal.context);
		expect(states(literal).filter(item => item.state === "input")).toHaveLength(1);
	});

	it("refuses invalid image ownership counts and does not report image-bearing shortcuts as empty resume", async () => {
		for (const images of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
			const test = harness({ jobsEpoch: "current", requests: [watch("invalid", "exact prompt", "session", "current", images)] });
			await test.handlers.get("session_start")!({}, test.context);
			expect(states(test)).toEqual([]);
		}
		const test = harness({ jobsEpoch: "current", requests: [watch("shortcut", ".", "session", "current", 1)] });
		await test.handlers.get("session_start")!({}, { ...test.context, sessionManager: { ...test.context.sessionManager, getBranch: () => [] } });
		expect(states(test)[0].emptyResume).toBe(false);
	});

	it("checks the classic draft, arms and checks again in one job without allowing a foreign input through", async () => {
		const job = { ...watch("classic"), prompt: { ...watch("classic").prompt, classicEditor: { expected: "" } } };
		const test = harness({ jobsEpoch: "current", requests: [job] });
		const read = vi.fn(() => "");
		const context = { ...test.context, ui: { ...test.context.ui, getEditorText: read } };
		read.mockImplementationOnce(() => "").mockImplementationOnce(() => {
			test.handlers.get("input")!(input(), context);
			return "";
		});
		await test.handlers.get("session_start")!({}, context);
		expect(read).toHaveBeenCalledTimes(2);
		expect(states(test).some(item => item.state === "armed")).toBe(false);
		expect(states(test).at(-1)).toMatchObject({ id: "classic", state: "error", error: expect.stringMatching(/another input|again/i) });
		test.handlers.get("input")!(input(), context);
		expect(states(test).filter(item => item.state === "input")).toHaveLength(1);
	});

	it.each(["private", "unavailable", "changed"] as const)("refuses a classic %s draft without clearing it or observing a later prompt", async state => {
		const job = { ...watch("classic"), prompt: { ...watch("classic").prompt, classicEditor: { expected: "" } } };
		const test = harness({ jobsEpoch: "current", requests: [job] });
		let draft = state === "private" ? "Private native draft" : "";
		let reads = 0;
		const read = vi.fn(() => {
			if (state === "unavailable") throw new Error("SDK editor unavailable");
			if (state === "changed" && ++reads === 2) draft = "New native draft";
			return draft;
		});
		const clear = vi.fn();
		const context = { ...test.context, ui: { ...test.context.ui, getEditorText: read, setEditorText: clear } };
		await test.handlers.get("session_start")!({}, context);
		expect(states(test)).toEqual([expect.objectContaining({ id: "classic", state: "error", error: expect.any(String) })]);
		test.handlers.get("input")!(input(), context);
		expect(states(test).filter(item => item.state === "input")).toEqual([]);
		expect(clear).not.toHaveBeenCalled();
		expect(draft).toBe(state === "private" ? "Private native draft" : state === "changed" ? "New native draft" : "");
	});

	it("accepts an empty classic editor or its exact staged draft in one observation job", async () => {
		for (const draft of ["", "IMAGE #1 "]) {
			const job = { ...watch("classic"), prompt: { ...watch("classic").prompt, classicEditor: { expected: "IMAGE #1 " } } };
			const test = harness({ jobsEpoch: "current", requests: [job] });
			const read = vi.fn(() => draft);
			const context = { ...test.context, ui: { ...test.context.ui, getEditorText: read } };
			await test.handlers.get("session_start")!({}, context);
			test.handlers.get("input")!(input(), context);
			expect(read).toHaveBeenCalledTimes(2);
			expect(states(test).map(item => item.state)).toEqual(["armed", "input"]);
		}
	});
});
