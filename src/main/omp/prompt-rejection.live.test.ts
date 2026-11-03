import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { HostState } from "@shared/ipc";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { afterAll, describe, expect, it, vi, type MockInstance } from "vitest";

// Only shell/environment surfaces are replaced. Host, controller, controller-owned GuestClient,
// encrypted loopback relay, native extension, native bridge, and PTY all run their production code.
const isolated = vi.hoisted(() => ({
	env: {} as NodeJS.ProcessEnv,
	bin: "",
	cleanup: false,
	emit: (_channel: string, _value: unknown): void => {},
}));
vi.mock("../env", () => ({ userEnv: async () => isolated.env, ptyEnv: (env: NodeJS.ProcessEnv) => env }));
vi.mock("../ipc", () => ({ broadcast: (channel: string, value: unknown) => isolated.emit(channel, value) }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ theme: "light", reducedMotion: "on" }) }));
vi.mock("./locate", () => ({ ompPath: async () => isolated.bin }));
vi.mock("./sessions", () => ({ findSessionFile: async () => null, onSessionsChanged: vi.fn() }));
vi.mock("../../renderer/src/ui/toast", () => ({ toast: vi.fn() }));
vi.mock("electron", () => ({
	BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
	dialog: { showMessageBox: vi.fn(async () => {
		if (!isolated.cleanup) throw new Error("Unexpected native dialog in isolated live fixture");
		return { response: 1 };
	}) },
	nativeTheme: { on: vi.fn(), removeListener: vi.fn(), shouldUseDarkColors: false },
	systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) },
}));

import { SessionHost } from "./host";
import { nativeBridge, type NativeBridge } from "./native-bridge";
import { classicPromptRejections, semanticPromptRejections } from "./prompt-rejection";

type Transport = "classic" | "tsp";
type Failure = NonNullable<HostState["promptFailures"]>[number];
interface ProviderRequest { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> }
interface QueuedMessage {
	id: string;
	text: string;
	images: readonly { path: string; name: string }[];
	error?: string;
}
// Keep the renderer's DOM/TSX graph out of the main-process typecheck. The runtime import below
// still constructs the production controller; this is only the narrow contract the harness uses.
interface LiveController {
	attach(host: HostState): void;
	getSnapshot(): {
		queue: readonly QueuedMessage[];
		guest: { phase: string; entries: readonly SessionEntry[] } | null;
		working: boolean;
		strandedImages: boolean;
	};
	subscribe(listener: () => void): () => void;
	send(text: string, images?: QueuedMessage["images"]): Promise<void>;
	sendNow(id: string): Promise<void>;
	removeQueued(id: string): void;
	dispose(): Promise<void>;
}
interface Evidence {
	name: string;
	transport: Transport;
	version?: string;
	status: "running" | "passed" | "failed" | "not-required-18.15";
	steps: Array<{ action: string; diagnostic: string | null; draft: string | null; queueResult: Array<{ text: string; error: string | null }>; providerCount: number }>;
	timing?: {
		sample: number;
		submissionStartMs: number;
		inputReceiptMs: number;
		elapsedMs: number;
		editorPeekJobs: number;
		promptWatchJobs: number;
	};
}
const evidence: Evidence[] = [];
const runFile = promisify(execFile);
const commonArgs = ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title"];
const fixtureModel = "fixture/fixture-model";

interface BridgeObservation {
	editor: MockInstance<NativeBridge["editorDraft"]>;
	watch: MockInstance<NativeBridge["watchPrompt"]>;
	shutdown: MockInstance<NativeBridge["requestShutdown"]>;
}

// These are call-through spies, not bridge replacements: all recorded promises are real SDK replies.
function observeBridge(host: SessionHost): BridgeObservation {
	const bridge = nativeBridge(host.id);
	return { editor: vi.spyOn(bridge, "editorDraft"), watch: vi.spyOn(bridge, "watchPrompt"), shutdown: vi.spyOn(bridge, "requestShutdown") };
}
interface Fixture {
	root: string;
	agent: string;
	transport: Transport;
	legacy: boolean;
	controller: LiveController;
	host?: SessionHost;
	hosts: SessionHost[];
	observations: Map<string, BridgeObservation>;
	submits: Array<{ hostId: string; text: string; id: string }>;
	acks: string[];
	failures: Map<string, Failure>;
	requests: ProviderRequest[];
	providerErrors: string[];
	baseUrl: string;
	expectedProviderText?: string;
	expectedProviderImages: string[];
	maxUserEntries: number;
	report: Evidence;
}

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!await predicate()) {
		if (Date.now() >= deadline) throw new Error(label);
		await sleep(40);
	}
}

/** Compare authored text after checking omp's own reminder and attachment envelopes. */
function providerUserTexts(request: ProviderRequest, imagePaths: readonly string[]): string[] {
	const users = request.messages.filter(message => message.role === "user");
	const images = users.flatMap(message => typeof message.content === "string" ? [] : message.content.filter(part => part.type === "image_url"));
	expect(images).toHaveLength(imagePaths.length);
	const texts = users.map(message => typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text ?? "").join(""));
	const notices = texts.filter(text => text.startsWith("The user attached an image as "));
	expect(notices).toHaveLength(imagePaths.length);
	for (const [index, path] of imagePaths.entries()) {
		expect(notices[index]).toContain(`The user attached an image as \`[Image #${index + 1}]\` in their visible message.`);
		expect(notices[index]).toContain(`Source path: \`${path}\``);
	}
	return texts.filter(text => !notices.includes(text)).map(text => {
		let authored = text.replace(/^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]+'\. Do not repeat this information in your reply\.\n<\/system-reminder>(?:\n\n)?/, "");
		for (let index = 1; index <= imagePaths.length; index++) {
			const marker = new RegExp(`^\\[Image #${index}(?:, \\d+x\\d+)?\\]\\s*`);
			expect(authored).toMatch(marker);
			authored = authored.replace(marker, "");
		}
		return authored;
	});
}

async function writeConfig(fixture: Pick<Fixture, "agent">, configured = false): Promise<void> {
	await writeFile(join(fixture.agent, "config.yml"), JSON.stringify({
		setupVersion: 999,
		startup: { setupWizard: false, checkUpdate: false, changelogMode: "hidden", quiet: true },
		marketplace: { autoUpdate: "off" },
		autocomplete: { enabled: false }, composer: { predictions: false }, recap: { enabled: false },
		memory: { enabled: false }, idle: { enabled: false }, retry: { modelFallback: false },
		worktree: { onStart: "off", onExit: "keep" },
		...(configured ? { modelRoles: { default: fixtureModel, smol: fixtureModel } } : {}),
	}));
}

async function configureProvider(fixture: Fixture): Promise<void> {
	await writeFile(join(fixture.agent, "models.yml"), JSON.stringify({ providers: { fixture: {
		baseUrl: fixture.baseUrl, apiKey: "local-fixture-only", api: "openai-completions",
		models: [{ id: "fixture-model", name: "Prompt rejection fixture", reasoning: true, input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
	} } }));
	await writeConfig(fixture, true);
}

async function startHost(fixture: Fixture, model?: string): Promise<SessionHost> {
	const host = new SessionHost({ cwd: fixture.root, extraArgs: [...commonArgs, ...(model ? ["--model", model, "--thinking", "off"] : [])] });
	fixture.hosts.push(host);
	fixture.host = host;
	await host.start();
	await until(() => host.state.phase === "live" && !!host.state.sessionId && !!host.state.link, "Host did not publish a live room");
	fixture.observations.set(host.id, observeBridge(host));
	fixture.controller.attach(host.state);
	await until(() => fixture.controller.getSnapshot().guest?.phase === "live" && !fixture.controller.getSnapshot().working, "Controller-owned collab guest did not join");
	await until(async () => (await peek(fixture)).text === "", "Native editor did not start empty");
	if (fixture.transport === "tsp") {
		await until(() => host.tspSnapshot()?.availability.available === true, "TSP editor did not become available");
	} else await until(async () => (await host.tuiFocus())?.overlays === 0, "Classic editor did not become available");
	return host;
}

function peek(fixture: Fixture) {
	const host = fixture.host!;
	return nativeBridge(host.id).editorDraft({ operation: "peek", sessionId: host.state.sessionId! });
}

async function assertEmptyEditor(fixture: Fixture): Promise<void> {
	const draft = await peek(fixture);
	expect(draft.text).toBe("");
	expect(draft.imageChips ?? 0).toBe(0);
	expect(draft.error).toBeUndefined();
}

async function paintedDiagnostic(fixture: Fixture): Promise<string | undefined> {
	const host = fixture.host!;
	if (fixture.transport === "tsp") return semanticPromptRejections(host.tspSnapshot()?.surfaces ?? [])[0]?.text;
	return classicPromptRejections(await host.screenLines())[0]?.text;
}

function queue(fixture: Fixture): readonly QueuedMessage[] { return fixture.controller.getSnapshot().queue; }
function redact(fixture: Fixture, text: string): string { return text.replaceAll(fixture.root, "<scratch>"); }
async function record(fixture: Fixture, action: string, diagnostic: string | null = null): Promise<void> {
	fixture.report.steps.push({ action, diagnostic: diagnostic && redact(fixture, diagnostic), draft: (await peek(fixture)).text,
		queueResult: queue(fixture).map(item => ({ text: item.text, error: item.error ? redact(fixture, item.error) : null })), providerCount: fixture.requests.length });
}

async function assertHeld(fixture: Fixture): Promise<void> {
	const before = queue(fixture).map(item => ({ ...item }));
	const submissions = fixture.submits.length;
	const requests = fixture.requests.length;
	// A bounded negative observation spans native polls, collab idle frames, and host state broadcasts.
	await sleep(800);
	expect(queue(fixture)).toEqual(before);
	expect(fixture.submits).toHaveLength(submissions);
	expect(fixture.requests).toHaveLength(requests);
	await assertEmptyEditor(fixture);
}

async function assertRejected(fixture: Fixture, text: string, diagnosticPrefix: string): Promise<QueuedMessage> {
	await until(() => queue(fixture).some(item => item.text === text && item.error?.startsWith(diagnosticPrefix)), "Rejected input was not retained with omp's diagnostic");
	const rows = queue(fixture).filter(item => item.text === text);
	expect(rows).toHaveLength(1);
	const row = rows[0]!;
	const sent = fixture.submits.findLast(item => item.text === text)!;
	expect(sent.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
	const failure = fixture.failures.get(sent.id)!;
	expect(failure).toMatchObject({ id: sent.id, generation: fixture.host!.state.generation, diagnostic: row.error, cleared: true });
	await until(() => fixture.acks.includes(sent.id) && !fixture.host!.state.promptFailures?.some(item => item.id === sent.id), "Controller did not acknowledge its retained failure");
	expect(fixture.controller.getSnapshot().strandedImages).toBe(false);
	await assertEmptyEditor(fixture);
	const observed = fixture.observations.get(fixture.host!.id)!;
	const watchIndex = observed.watch.mock.calls.findIndex(([watch]) => watch.id === sent.id);
	expect(watchIndex).toBeGreaterThanOrEqual(0);
	expect(observed.watch.mock.calls[watchIndex]).toEqual([{ id: sent.id, sessionId: fixture.host!.state.sessionId, text, ...(fixture.transport === "classic" ? { classicEditor: { expected: "" } } : {}) }]);
	const armed = observed.watch.mock.results[watchIndex]!;
	expect(armed.type).toBe("return");
	if (armed.type === "return") expect(await armed.value).toEqual({ emptyResume: false });
	const replies = await Promise.all(observed.editor.mock.results.map(result => result.type === "return" ? result.value.catch(() => null) : null));
	// The exact draft came from the trusted SDK, not a screen scrape or an invented queue row.
	expect(replies.some(reply => reply?.text === text)).toBe(true);
	if (fixture.transport === "classic") {
		const taken = observed.editor.mock.calls.findIndex(([request]) => request.operation === "take" && request.expected === text);
		expect(taken).toBeGreaterThanOrEqual(0);
		expect(replies[taken]).toMatchObject({ text, cleared: true });
	} else {
		expect(fixture.host!.composerFacts().text).toBe("");
		expect(fixture.host!.screenReadAttempts()).toEqual([]);
	}
	expect(fixture.requests).toHaveLength(0);
	expect(fixture.maxUserEntries).toBe(0);
	await record(fixture, `rejected:${text}`, row.error!);
	return row;
}

async function assertSuccessfulSend(fixture: Fixture, text: string): Promise<void> {
	await until(() => {
		if (fixture.providerErrors.length) throw new Error(fixture.providerErrors.join("\n"));
		return fixture.requests.length > 0 && fixture.controller.getSnapshot().guest?.entries.some(entry => entry.type === "message" && entry.message.role === "assistant") === true && !fixture.controller.getSnapshot().working;
	}, "Scripted provider turn did not finish through collab");
	expect(fixture.providerErrors).toEqual([]);
	expect(fixture.requests).toHaveLength(1);
	expect(providerUserTexts(fixture.requests[0]!, fixture.expectedProviderImages)).toEqual([text]);
	const sent = fixture.submits.findLast(item => item.text === text)!;
	await until(() => fixture.acks.includes(sent.id), "Positive collab evidence did not retire the successful submission");
	expect(fixture.failures.has(sent.id)).toBe(false);
	expect(fixture.host!.state.promptFailures ?? []).toEqual([]);
	await assertEmptyEditor(fixture);
	await record(fixture, `successful:${text}`);
}

async function withFixture(name: string, transport: Transport, work: (fixture: Fixture) => Promise<void>): Promise<void> {
	let controller: LiveController | undefined;
	let provider: Server | undefined;
	const hosts: SessionHost[] = [];
	const previous = { env: isolated.env, bin: isolated.bin, emit: isolated.emit, cleanup: isolated.cleanup };
	const report: Evidence = { name, transport, status: "running", steps: [] };
	evidence.push(report);
	const root = await mkdtemp(join(tmpdir(), "vomp-prompt-rejection-"));
	try {
		const home = join(root, "home"), agent = join(root, "agent");
		await Promise.all([mkdir(home), mkdir(agent)]);
		isolated.bin = resolve(process.env.OMP_BIN!);
		// Never spread process.env: credentials, proxy settings, plugins and owner config stay outside.
		isolated.env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
			XDG_CACHE_HOME: join(home, ".cache"), PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: agent,
			TMPDIR: root, TERM: "xterm-256color", COLORTERM: "truecolor", OMP_SKIP_SETUP: "1" };
		const { stdout } = await runFile(isolated.bin, ["--version"], { cwd: root, env: isolated.env, timeout: 15_000 });
		report.version = /\b(18\.(?:15|16)\.\d+)\b/.exec(stdout)?.[1];
		expect(report.version, "This gate covers the supplied omp 18.15/18.16 binaries").toBeDefined();
		vi.stubEnv("VOMP_TSP", transport === "tsp" ? undefined : "0");
		const listeners = new Map<string, Set<(value: unknown) => void>>();
		const fixture: Fixture = { root, agent, transport, legacy: report.version!.startsWith("18.15."), controller: undefined!, hosts,
			observations: new Map(), submits: [], acks: [], failures: new Map(), requests: [], providerErrors: [], baseUrl: "", expectedProviderImages: [], maxUserEntries: 0, report };
		isolated.emit = (channel, value) => {
			if (channel === "host:state") for (const failure of (value as HostState).promptFailures ?? []) fixture.failures.set(failure.id, failure);
			for (const listener of listeners.get(channel) ?? []) listener(value);
		};
		vi.stubGlobal("window", { setTimeout, clearTimeout, vomp: {
			on: (channel: string, listener: (value: unknown) => void) => {
				const group = listeners.get(channel) ?? new Set();
				group.add(listener); listeners.set(channel, group);
				return () => group.delete(listener);
			},
			invoke: async (channel: string, ...args: unknown[]) => {
				if (channel === "sessions:find") return null;
				if (channel === "sessions:follow") return;
				const host = hosts.find(item => item.id === args[0]);
				if (!host) throw new Error(`Unexpected live-gate host for ${channel}`);
				switch (channel) {
					case "host:submit": {
						const [text, mode, images, id] = args.slice(1) as Parameters<SessionHost["submit"]>;
						if (!id) throw new Error("An ordinary controller submission must have an id");
						fixture.submits.push({ hostId: host.id, text, id });
						return host.submit(text, mode, images, id);
					}
					case "host:ack-submission": fixture.acks.push(args[1] as string); return host.acknowledgeSubmission(args[1] as string);
					case "host:stop": return host.stop(args[1] as Parameters<SessionHost["stop"]>[0]);
					case "host:tsp-snapshot": return host.tspSnapshot();
					case "host:tsp-questions": return host.tspQuestions(args[1]);
					case "host:keys": return host.keys(...args.slice(1) as Parameters<SessionHost["keys"]>);
					case "host:ack-editor-restore": return host.ackEditorRestore(args[1] as string);
					case "host:retry-editor-restore": return host.retryEditorRestore(args[1] as string);
					case "composer:paste": return host.paste(args[1] as string, true);
					case "native:asyncWork": return nativeBridge(host.id).asyncWork(args[1] as number);
					default: throw new Error(`Unexpected live-gate IPC ${channel}`);
				}
			},
		} });
		// This test intentionally crosses main/renderer module-loading boundaries. A static import
		// cannot work in tsconfig.node, which has neither DOM libraries nor JSX support.
		const controllerModule = "../../renderer/src/state/session.ts";
		const { SessionController } = await import(/* @vite-ignore */ controllerModule);
		const live: LiveController = new SessionController({ tabId: "live-rejection", projectPath: root, sessionFile: null });
		controller = fixture.controller = live;
		live.subscribe(() => {
			const count = live.getSnapshot().guest?.entries.filter(entry => entry.type === "message" && entry.message.role === "user").length ?? 0;
			fixture.maxUserEntries = Math.max(fixture.maxUserEntries, count);
		});
		provider = createServer(async (request, response) => {
			try {
				const parts: Buffer[] = [];
				for await (const part of request) parts.push(Buffer.from(part));
				const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as ProviderRequest;
				fixture.requests.push(body);
				expect(request.method).toBe("POST");
				expect(request.url).toBe("/v1/chat/completions");
				expect(fixture.expectedProviderText, "No provider request is allowed before explicit user retry/send").toBeDefined();
				expect(fixture.requests).toHaveLength(1);
				expect(providerUserTexts(body, fixture.expectedProviderImages)).toEqual([fixture.expectedProviderText]);
				const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "rejection-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(chunk({ role: "assistant", content: "Exact fixture prompt received." }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
			} catch (error) {
				const actual = typeof error === "object" && error !== null && "actual" in error ? JSON.stringify(error.actual) : "";
				fixture.providerErrors.push(`${error instanceof Error ? error.message : String(error)}${actual ? `\nActual fixture input: ${actual}` : ""}`);
				response.writeHead(500).end("Fixture request rejected");
			}
		});
		const listening = Promise.withResolvers<void>();
		provider.once("error", listening.reject);
		provider.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		provider.off("error", listening.reject);
		const address = provider.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture provider port");
		fixture.baseUrl = `http://127.0.0.1:${address.port}/v1`;
		await writeConfig(fixture);
		await work(fixture);
		if (report.status === "running") report.status = "passed";
	} catch (error) {
		report.status = "failed";
		throw error;
	} finally {
		isolated.cleanup = true;
		try { await controller?.dispose(); }
		finally {
			try { await Promise.allSettled(hosts.map(host => host.stop("editor-recovery"))); }
			finally {
				try {
					if (provider) {
						provider.closeAllConnections();
						if (provider.listening) {
							const closed = Promise.withResolvers<void>();
							provider.close(error => error ? closed.reject(error) : closed.resolve());
							await closed.promise;
						}
					}
				} finally {
					try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
					finally {
						vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
						Object.assign(isolated, previous);
					}
				}
			}
		}
	}
}

const enabled = !!process.env.OMP_BIN && process.env.VOMP_PROMPT_REJECTION_LIVE === "1" && ["darwin", "linux"].includes(process.platform);
describe.skipIf(!enabled)("live rejected-prompt recovery with the application controller", () => {
	afterAll(async () => {
		const target = process.env.VOMP_PROMPT_REJECTION_REPORT;
		if (!target) return;
		await mkdir(dirname(resolve(target)), { recursive: true });
		await writeFile(resolve(target), JSON.stringify({
			isolation: "Scratch HOME and agent directory; allowlisted environment; zero-cost scripted loopback provider; no owner credentials",
			timingMeasure: "Monotonic performance.now immediately before controller.send to NativeBridge.onPromptInput receipt of the trusted extension's matching public input event. Includes controller/main submission work, native job polling, PTY delivery, omp input handling, and extension-to-main loopback HTTP transport. Excludes startup and does not measure provider request latency. Each sample uses a fresh host; all successful turns finish through the scripted loopback provider.",
			cases: evidence,
		}, null, 2));
	});

	it.each(["classic", "tsp"] as const)("measures submission start to trusted omp input observation (%s)", async transport => {
		for (let sample = 1; sample <= 5; sample++) {
			await withFixture(`submission-input-timing-${sample}`, transport, async fixture => {
				await configureProvider(fixture);
				const host = await startHost(fixture, fixtureModel);
				const bridge = nativeBridge(host.id);
				const original = bridge.onPromptInput;
				expect(original).toBeTypeOf("function");
				const receipts: Array<{ id: string; at: number }> = [];
				bridge.onPromptInput = function (id) {
					receipts.push({ id, at: performance.now() });
					original?.call(bridge, id);
				};
				try {
					const observed = fixture.observations.get(host.id)!;
					const editorStart = observed.editor.mock.calls.length;
					const watchStart = observed.watch.mock.calls.length;
					const text = `INPUT_TIMING_${transport}_${sample}\nPreserve this exact input.`;
					fixture.expectedProviderText = text;
					const submissionStartMs = performance.now();
					await fixture.controller.send(text);
					await until(() => receipts.length > 0, "Trusted extension did not report the submitted input");
					const sent = fixture.submits.find(item => item.text === text)!;
					expect(sent).toBeDefined();
					expect(receipts).toHaveLength(1);
					expect(receipts[0]!.id).toBe(sent.id);
					const editorPeekJobs = observed.editor.mock.calls.slice(editorStart).filter(([request]) => request.operation === "peek").length;
					const promptWatchJobs = observed.watch.mock.calls.length - watchStart;
					expect(editorPeekJobs).toBe(0);
					expect(promptWatchJobs).toBe(1);
					expect(observed.watch.mock.calls[watchStart]).toEqual([{ id: sent.id, sessionId: host.state.sessionId, text, ...(transport === "classic" ? { classicEditor: { expected: "" } } : {}) }]);
					const inputReceiptMs = receipts[0]!.at;
					expect(inputReceiptMs).toBeGreaterThan(submissionStartMs);
					fixture.report.timing = { sample, submissionStartMs, inputReceiptMs, elapsedMs: inputReceiptMs - submissionStartMs, editorPeekJobs, promptWatchJobs };
					await assertSuccessfulSend(fixture, text);
					expect(queue(fixture)).toEqual([]);
				} finally {
					bridge.onPromptInput = original;
				}
			});
		}
	}, 120_000);

	it.each((["classic", "tsp"] as const).flatMap(transport => (["model", "credential"] as const).map(missing => ({ transport, missing }))))(
		"retains normal, queued and Send now missing-$missing rejections, then retries explicitly ($transport)", async ({ transport, missing }) => {
			await withFixture(`missing-${missing}`, transport, async fixture => {
				// Override even the keyless built-in provider's URL: an unexpected request can only hit our loopback recorder.
				if (missing === "credential") await writeFile(join(fixture.agent, "models.yml"), JSON.stringify({ providers: { anthropic: { baseUrl: fixture.baseUrl } } }));
				const firstHost = await startHost(fixture, missing === "credential" ? "anthropic/claude-sonnet-4-5" : undefined);
				const prefix = missing === "model" ? "No model selected." : "No API key found for anthropic.";
				const first = "FIRST_REJECTED_SENTINEL\nKeep this exact second line.";
				await fixture.controller.send(first);
				if (fixture.legacy) {
					await until(async () => (await paintedDiagnostic(fixture))?.startsWith(prefix) === true, "omp 18.15 did not paint its preflight diagnostic");
					await assertHeld(fixture);
					expect(queue(fixture)).toEqual([]);
					expect(fixture.failures.size).toBe(0);
					expect(fixture.acks).toEqual([]);
					expect(fixture.maxUserEntries).toBe(0);
					await record(fixture, "18.15-empty-editor-no-fabricated-rejection", (await paintedDiagnostic(fixture))!);
					await firstHost.stop();
					await configureProvider(fixture);
					await startHost(fixture, fixtureModel);
					await assertHeld(fixture);
					fixture.expectedProviderText = first;
					await fixture.controller.send(first);
					await assertSuccessfulSend(fixture, first);
					return;
				}
				const rejectedFirst = await assertRejected(fixture, first, prefix);
				await assertHeld(fixture);
				const second = "QUEUED_REJECTED_SENTINEL\nDo not concatenate the first prompt.";
				await fixture.controller.send(second);
				expect(queue(fixture).map(item => item.text)).toEqual([first, second]);
				await assertHeld(fixture);
				// A normal queued delivery is released by the user removing the failed row in front.
				fixture.controller.removeQueued(rejectedFirst.id);
				const rejectedSecond = await assertRejected(fixture, second, prefix);
				expect(queue(fixture).map(item => item.text)).toEqual([second]);
				const third = "SEND_NOW_REJECTED_SENTINEL\nDo not concatenate either earlier prompt.";
				await fixture.controller.send(third);
				await assertHeld(fixture);
				const queuedThird = queue(fixture).find(item => item.text === third)!;
				await fixture.controller.sendNow(queuedThird.id);
				const rejectedThird = await assertRejected(fixture, third, prefix);
				expect(queue(fixture).map(item => item.text)).toEqual([second, third]);
				expect(fixture.submits.map(item => item.text)).toEqual([first, second, third]);
				expect(new Set(fixture.submits.map(item => item.id)).size).toBe(3);
				await assertHeld(fixture);
				const retained = queue(fixture).map(item => ({ ...item }));
				const sameController = fixture.controller;
				await firstHost.stop();
				await configureProvider(fixture);
				await startHost(fixture, fixtureModel);
				expect(fixture.controller).toBe(sameController);
				expect(queue(fixture)).toEqual(retained);
				await assertHeld(fixture);
				await record(fixture, "configured-and-ready-without-autoresend");
				fixture.expectedProviderText = second;
				await fixture.controller.sendNow(rejectedSecond.id);
				await assertSuccessfulSend(fixture, second);
				expect(queue(fixture)).toEqual([rejectedThird]);
				await assertHeld(fixture);
				fixture.controller.removeQueued(rejectedThird.id);
				expect(queue(fixture)).toEqual([]);
				expect(fixture.requests).toHaveLength(1);
			});
		}, 120_000,
	);

	it.each(["classic", "tsp"] as const)("keeps a rejected image with its text and retries once after explicit relaunch (%s)", async transport => {
		await withFixture("missing-model-image", transport, async fixture => {
			if (fixture.legacy) { fixture.report.status = "not-required-18.15"; return; }
			const path = join(fixture.root, "fixture.webp");
			// Valid image bytes from the standalone classic-image-success fixture's decoded output.
			await writeFile(path, Buffer.from("UklGRoIAAABXRUJQVlA4IHYAAABQDACdASrIAMgAPm02mUmkIyKhIEgAgA2JaW7hdrEbQBPa9FXCDIIaqk122i4QZBDVUmu20XCDIIaqk122i4QZBDVUmu20XCDIIaqk122i4QZBDVUmu20XCDIIaqk122i4QZBDVUmu20WcAAD+/9GgAAAAAAAA", "base64"));
			const image = { path, name: "fixture.webp" };
			const text = "REJECTED_IMAGE_SENTINEL\nKeep this image with its original text.";
			const first = await startHost(fixture);
			await fixture.controller.send(text, [image]);
			await until(() => queue(fixture).some(item => item.text === text && item.error?.startsWith("No model selected.")), "Rejected image prompt was not retained").catch(async error => {
				throw new Error(`${String(error)}\nQueue: ${JSON.stringify(queue(fixture))}\nExact editor: ${JSON.stringify(await peek(fixture))}\nDiagnostic: ${await paintedDiagnostic(fixture)}\nScreen: ${transport === "classic" ? JSON.stringify(await fixture.host!.screenLines()) : "semantic"}`);
			});
			const row = queue(fixture).find(item => item.text === text)!;
			expect(row.images).toEqual([image]);
			expect(fixture.requests).toHaveLength(0);
			const sent = fixture.submits[0]!;
			expect(fixture.failures.get(sent.id)?.cleared).toBe(transport === "tsp");
			expect(fixture.controller.getSnapshot().strandedImages).toBe(transport === "classic");
			if (transport === "tsp") await assertEmptyEditor(fixture);
			else expect((await peek(fixture)).text).not.toBe("");
			await record(fixture, "rejected-image-retained", row.error!);
			await first.stop();
			if (transport === "classic") expect(fixture.observations.get(first.id)!.shutdown).toHaveBeenCalledOnce();
			await configureProvider(fixture);
			await startHost(fixture, fixtureModel);
			await assertHeld(fixture);
			fixture.expectedProviderText = text;
			fixture.expectedProviderImages = [path];
			await fixture.controller.sendNow(row.id);
			await assertSuccessfulSend(fixture, text);
			const request = fixture.requests[0]!;
			const images = request.messages.filter(message => message.role === "user").flatMap(message => typeof message.content === "string" ? [] : message.content.filter(part => part.type === "image_url"));
			expect(images).toHaveLength(1);
			expect(queue(fixture)).toEqual([]);
		});
	}, 90_000);

	it.each((["classic", "tsp"] as const).flatMap(transport => ([".", "c"] as const).map(text => ({ transport, text }))))(
		"retains the consumed empty-editor Nothing to resume outcome for '$text' ($transport)", async ({ transport, text }) => {
			await withFixture(`empty-resume-${text}`, transport, async fixture => {
				if (fixture.legacy) { fixture.report.status = "not-required-18.15"; return; }
				await startHost(fixture);
				await fixture.controller.send(text);
				await until(() => queue(fixture).some(item => item.text === text && /^Nothing to resume\.?$/.test(item.error ?? "")), "Consumed resume input was not retained");
				const sent = fixture.submits[0]!;
				const observed = fixture.observations.get(fixture.host!.id)!;
				expect(observed.watch.mock.calls).toEqual([[{ id: sent.id, sessionId: fixture.host!.state.sessionId, text, ...(transport === "classic" ? { classicEditor: { expected: "" } } : {}) }]]);
				const result = observed.watch.mock.results[0]!;
				expect(result.type).toBe("return");
				if (result.type === "return") expect(await result.value).toEqual({ emptyResume: true });
				expect(fixture.failures.get(sent.id)).toMatchObject({ diagnostic: queue(fixture)[0]!.error, cleared: true });
				await until(() => fixture.acks.includes(sent.id), "Consumed resume failure was not acknowledged");
				expect(fixture.host!.state.promptFailures ?? []).toEqual([]);
				expect(fixture.maxUserEntries).toBe(0);
				expect(fixture.requests).toHaveLength(0);
				expect(observed.editor.mock.calls.some(([request]) => request.operation === "take")).toBe(false);
				await assertHeld(fixture);
				await record(fixture, "trusted-empty-resume-consumed", queue(fixture)[0]!.error!);
			});
		}, 60_000,
	);

	it("closes classic with a hidden user draft through SDK shutdown without submitting it", async () => {
		await withFixture("classic-close-hidden-draft", "classic", async fixture => {
			await configureProvider(fixture);
			const host = await startHost(fixture, fixtureModel);
			const draft = "HIDDEN_USER_DRAFT_SENTINEL\nThis must never be sent, including with /exit appended.";
			expect(await nativeBridge(host.id).editorDraft({ operation: "restore", sessionId: host.state.sessionId!, expected: "", restoreText: draft })).toMatchObject({ restored: true });
			expect((await peek(fixture)).text).toBe(draft);
			await record(fixture, "hidden-user-draft-before-normal-close");
			const observation = fixture.observations.get(host.id)!;
			await host.stop(); // Normal close, deliberately not editor-recovery.
			expect(host.state.phase).toBe("exited");
			expect(observation.shutdown).toHaveBeenCalledTimes(1);
			expect(fixture.submits).toEqual([]);
			expect(fixture.requests).toHaveLength(0);
			expect(fixture.maxUserEntries).toBe(0);
			fixture.report.steps.push({ action: "normal-close-sdk-shutdown-without-submit", diagnostic: null, draft, queueResult: [], providerCount: 0 });
		});
	}, 60_000);
});
