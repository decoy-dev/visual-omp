import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { WebSocket } from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { FixtureDocuments, loadFixtureRecording, loadCommandFeedbackRecording, parseFixtureInputs, type FixtureInput, type FixtureRecording } from "../../../../renderer/src/features/tsp/testing/documents";
import { hookQuestions } from "@shared/tsp/hook-questions";
import { openOverlay, screenSurface, walkNodes } from "@shared/tsp/view-state";
import { plain } from "../../../../renderer/src/state/tsp/labels";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { TspRendererEvent } from "@shared/tsp-host.schema";
import { hookAnswerEvents } from "@shared/tsp/dialogs";
import { TspHookAnswer } from "@shared/tsp/dialogs.schema";
import { planReview } from "@shared/tsp/plan-review";
import askFormEvidence from "../fixtures/18.18.3/ask-html-form.ask.json";
import { matchQuestions, type CollabQuestion } from "@shared/tsp/question-match";
import type { TspSurfaceSnapshot } from "@shared/tsp-host";
import { commandPanelFrames, replacePanelChild } from "@shared/tsp/testing/command-panel-fixtures";
import { commandReport } from "@shared/tsp/reports";
import { settledCommandPanel } from "@shared/tsp/command-panels";
import formGuest185 from "../fixtures/18.18.5/ask-fixture-form-guest.ask.json";
import formTabs185 from "../fixtures/18.18.5/ask-fixture-form-tabs.ask.json";
import fourTabs185 from "../fixtures/18.18.5/ask-four-fieldsets-tabs.ask.json";
import colors185 from "../fixtures/18.18.5/ask-fixture-colors.ask.json";
import tall185 from "../fixtures/18.18.5/ask-tall-form.ask.json";
import { QuestionArbitrator } from "@shared/tsp/question-arbitrator";
import { askFormPresentation, TSP_ROLES } from "@shared/tsp/roles";
import { TspSession } from "../session";
import { TspStream } from "../stream";
import type { CollabUiRequest, SessionEntry, ToolCallContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { FileRefRequest } from "@shared/contracts/fileRefs";
import { resolveFileRefs } from "../../../services/fileRefs";
import type { FormLayoutEvidence } from "../../../../renderer/src/features/tsp/testing/form-layout-types";

import { TspMainFeedback } from "../../../../renderer/src/state/tsp/main-feedback";
import type { MainOutput } from "@shared/tsp/main-output";
import type { TspNode } from "@shared/tsp";
/** Rows the gate page renders as command results. The renderer's own record type would pull session state into this project's compile. */
interface GateResultRow { id: string; command: string; lines: string[]; tone: MainOutput["tone"]; locations?: MainOutput["locations"]; anchor: null; room: string; createdAt: number; provenance: unknown[] }
const root = resolve(import.meta.dirname, "../../../../..");
const chrome = process.env.CHROME_BIN ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");

/** Explicit test-only baseline; production and ordinary gates always load working-tree sources. */
function formLayoutBaseline() {
	if (process.env.TSP_FORM_LAYOUT_GATE === "1" && process.env.TSP_FORM_CLOSE_BASELINE === "1") {
		const files = ["chat/ChatView.tsx", "chat/composer/Composer.tsx", "chat/composer/QueueTray.tsx", "chat/transcript/Transcript.tsx", "chat/transcript/QuestionCard.tsx", "ui/motion.tsx"];
		const sources = new Map(files.map(file => {
			const path = `src/renderer/src/${file}`;
			let source = execFileSync("git", ["show", `e557710:${path}`], { cwd: root, encoding: "utf8" });
			if (file === "chat/ChatView.tsx") source += '\nexport function WorkingStatus(props) { return <Expand open={!questionPresentation(props.view).pending && (props.view.working || props.view.guest?.awaitingAsyncWork === true || props.activity !== null)}><WorkingRow {...props} /></Expand>; }\n';
			return [resolve(root, path), source];
		}));
		return [{ name: "form-close-e557710-baseline", enforce: "pre" as const, load(id: string) { return sources.get(id.split("?")[0]!); } }];
	}
	if (process.env.TSP_FORM_LAYOUT_GATE !== "1" || process.env.TSP_FORM_LAYOUT_BASELINE !== "1") return [];
	const files = [
		"chat/transcript/QuestionCard.tsx", "chat/transcript/QuestionChoices.tsx",
		"chat/composer/Composer.tsx", "chat/composer/selection.ts", "chat/composer/QueueTray.tsx",
		"chat/transcript/Transcript.tsx",
	];
	const sources = new Map(files.map(file => {
		const path = `src/renderer/src/${file}`;
		return [resolve(root, path), execFileSync("git", ["show", `e88bd9d:${path}`], { cwd: root, encoding: "utf8" })];
	}));
	return [{ name: "form-layout-e88bd9d-baseline", enforce: "pre" as const, load(id: string) { return sources.get(id.split("?")[0]!); } }];
}

const CdpMessage = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional(), method: z.string().optional(), params: z.unknown().optional() });
interface AxTree { nodes: { role?: { value: string }; name?: { value: string }; properties?: { name: string; value: { value: unknown } }[] }[] }
interface Evaluation { result: { value: unknown }; exceptionDetails?: { text: string; exception?: { description: string } } }

/** Small CDP client so this gate uses the already-installed Chrome without another browser package. */
class ChromePage {
	#id = 0;
	#pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	readonly requests: string[] = [];
	readonly errors: string[] = [];
	constructor(private socket: WebSocket) {
		socket.on("message", raw => {
			try {
				const message = CdpMessage.parse(JSON.parse(String(raw)));
				if (message.method === "Network.requestWillBeSent") this.requests.push(z.object({ request: z.object({ url: z.string() }) }).parse(message.params).request.url);
				if (message.method === "Runtime.exceptionThrown") this.errors.push(JSON.stringify(message.params));
				const pending = message.id === undefined ? undefined : this.#pending.get(message.id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.#pending.delete(message.id!);
				if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
			} catch (error) { this.#fail(error instanceof Error ? error : new Error(String(error))); }
		});
		socket.on("close", () => this.#fail(new Error("Chrome CDP connection closed.")));
		socket.on("error", error => this.#fail(error));
	}
	#fail(error: Error): void {
		for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.#pending.clear();
	}
	send<T = unknown>(method: string, params: object = {}): Promise<T> {
		if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chrome CDP connection is not open."));
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const id = ++this.#id;
		const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Chrome CDP ${method} timed out.`)); }, 5_000);
		this.#pending.set(id, { resolve, reject, timer });
		this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) this.#fail(error); });
		// Each call supplies the response shape from Chrome's documented DevTools method.
		return promise as Promise<T>;
	}
	async evaluate<T = unknown>(expression: string): Promise<T> {
		const result = await this.send<Evaluation>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		return result.result.value as T;
	}
	async until(expression: string): Promise<void> {
		const deadline = Date.now() + 20_000;
		// Chrome runs out of process; fake timers cannot drive its render or focus lifecycle.
		while (!await this.evaluate(expression)) { if (Date.now() > deadline) throw new Error(`Chrome timed out: ${expression}\n${await this.evaluate("document.body.innerText.slice(0, 1600)")}\n${this.errors.join("\n")}`); await delay(25); }
	}
	async clickElement(expression: string, scroll = true): Promise<void> {
		const point = await this.evaluate<{ x: number; y: number }>(`(() => { const element = ${expression}; if (!element) throw new Error('Missing Chrome input target'); ${scroll ? "element.scrollIntoView({block:'center',inline:'nearest'});" : ""} const box = element.getBoundingClientRect(); if (${!scroll} && (box.top < 0 || box.bottom > innerHeight || box.left < 0 || box.right > innerWidth)) throw new Error('Layout gate input must already be visible'); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
		await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
		await this.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
		await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
	}
	async key(key: string, code = key, modifiers = 0, commands?: string[]): Promise<void> {
		await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, commands });
		await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
	}
	close() { this.#fail(new Error("Chrome CDP client closed.")); this.socket.close(); }
}

async function stopChrome(child: ChildProcess | undefined): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit").then(() => true);
	child.kill();
	if (await Promise.race([exited, delay(2_000, false)])) return;
	child.kill("SIGKILL");
	if (!await Promise.race([exited, delay(2_000, false)])) throw new Error("Chrome did not stop after SIGKILL.");
}

function fixtureSnapshot(documents: FixtureDocuments, generation = 1, revision = 1): TspHostSnapshot {
	const snapshot = documents.snapshot();
	return { ...snapshot, hostId: "gate", generation, revision, lifecycle: "live", documentGeneration: generation, failure: null, availability: { available: false, reason: "Recorded omp menu" },
		questionMatches: hookQuestions(snapshot.surfaces, generation).map(hook => ({ surfaceId: hook.surfaceId, nodeId: hook.nodeId, status: "unmatched" })),
		surfaces: snapshot.surfaces.map(surface => ({ ...surface, documentGeneration: generation })) };
}
function recorded(name: string, idle = false): TspHostSnapshot {
	const documents = new FixtureDocuments();
	for (const message of loadFixtureRecording(name).messages) {
		documents.receive({ verb: message.verb, body: JSON.stringify(message.body) });
		const snapshot = documents.snapshot();
		const nodes = snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]);
		const shown = idle ? nodes.some(node => node.k === "editor" && node.p?.sendable)
			: name === "settings-screen" ? nodes.some(node => node.k === "prefs")
			: name === "usage" ? nodes.some(node => JSON.stringify(node.p ?? {}).includes("No usage data available."))
			: !!openOverlay(snapshot.surfaces, true);
		if (message.verb === "f" && shown) return fixtureSnapshot(documents);
	}
	throw new Error(`No recorded screen in ${name}`);
}
interface AskEvidence {
	stages: { stage: string; afterMessage: number; surfaces: unknown; request: CollabUiRequest | null }[];
	sessions: { text: string }[];
	engineVersion?: string;
}
function askTranscript(evidence: AskEvidence): { entries: SessionEntry[]; call: ToolCallContent; result: ToolResultMessage } {
	const entries = evidence.sessions[0]!.text.trim().split("\n").map(line => JSON.parse(line) as SessionEntry);
	const calls = entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : []).filter((part): part is ToolCallContent => part.type === "toolCall" && part.name === "ask");
	expect(calls).toHaveLength(1);
	const results = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === calls[0]!.id ? [entry.message] : []);
	expect(results).toHaveLength(1);
	return { entries: entries.slice(0, entries.findIndex(entry => entry.type === "message" && entry.message.role === "toolResult")), call: calls[0]!, result: results[0]! };
}
function askSnapshots() {
	const scope = { hostId: "gate", generation: 1, epoch: 1 };
	const arbiter = new QuestionArbitrator();
	let revision = 0;
	return (stage: AskEvidence["stages"][number], requests = stage.request ? [stage.request] : []): TspHostSnapshot => {
		const surfaces = structuredClone(stage.surfaces as TspSurfaceSnapshot[]).map(surface => ({ ...surface, documentGeneration: 1 }));
		arbiter.update(scope, { ...scope, connection: 1, revision: ++revision, connected: true, requests });
		return { ...recorded("hook-select-open"), ...scope, revision, surfaces, questionMatches: arbiter.matches(scope, hookQuestions(surfaces, 1)) };
	};
}
const askCases185: { name: string; evidence: AskEvidence }[] = [
	{ name: "ask-fixture-form-guest", evidence: formGuest185 as AskEvidence },
	{ name: "ask-fixture-colors", evidence: colors185 as AskEvidence },
	{ name: "ask-fixture-form-tabs", evidence: formTabs185 as AskEvidence },
	{ name: "ask-four-fieldsets-tabs", evidence: fourTabs185 as AskEvidence },
	{ name: "ask-tall-form", evidence: tall185 as AskEvidence },
];

type WireInput = { keys: string } | { verb: "e"; body: TspRendererEvent };
const CapturedCalls = z.array(z.object({ channel: z.enum(["host:tsp-event", "host:tsp-answer", "host:keys"]), args: z.array(z.unknown()) }));
function wireInput(input: FixtureInput): WireInput { return "keys" in input ? { keys: input.keys } : { verb: "e", body: input.body }; }
function emittedInputs(snapshot: TspHostSnapshot, value: unknown): WireInput[] {
	return CapturedCalls.parse(value).flatMap((call): WireInput[] => {
		expect(call.args[0]).toBe(snapshot.hostId);
		expect(call.args[call.channel === "host:keys" ? 2 : 1]).toBe(snapshot.generation);
		expect(call.args[3]).toBe(snapshot.epoch);
		if (call.channel === "host:tsp-event") return [{ verb: "e" as const, body: TspRendererEvent.parse(call.args[2]) }];
		if (call.channel === "host:keys") {
			const keys = z.string().parse(call.args[1]);
			const hooks = hookQuestions(snapshot.surfaces, snapshot.generation);
			if (keys !== "escape" || hooks.length !== 1) return [{ keys: keys === "escape" ? "\x1b" : keys }];
			const hook = hooks[0]!;
			const root = snapshot.surfaces.find(surface => surface.open.id === hook.surfaceId);
			const node = root && [...walkNodes(root.document)].find(node => node.id === hook.nodeId);
			if (!node) throw new Error("Missing recorded hook for guarded Escape");
			const events = hookAnswerEvents(node, { kind: "cancel", sf: hook.surfaceId, id: hook.nodeId });
			return events.length ? events.map(body => ({ verb: "e" as const, body })) : [{ keys: "\x1b" }];
		}
		const answer = TspHookAnswer.parse(call.args[2]);
		const surface = snapshot.surfaces.find(surface => surface.open.id === answer.sf);
		const node = surface && [...walkNodes(surface.document)].find(node => node.id === answer.id);
		if (!node) throw new Error("Missing recorded hook answer target");
		// The renderer sends a complete transaction. This is the production writer's wire conversion.
		const events = hookAnswerEvents(node, answer);
		return events.length ? events.map(body => ({ verb: "e" as const, body })) : [{ keys: "\x1b" }];
	});
}
function hasRecordedMenu(documents: FixtureDocuments): boolean {
	const surfaces = documents.snapshot().surfaces.filter(surface => surface.sequence > 0 && !surface.closed);
	return !!(openOverlay(surfaces, true) || screenSurface(surfaces) || surfaces.some(surface => [...walkNodes(surface.document)].some(node => node.k === "rows")));
}
class CompletionReplay {
	documents = new FixtureDocuments();
	readonly recording: FixtureRecording;
	readonly expected: FixtureInput[];
	cursor = 0;
	#revision = 1;
	constructor(readonly name: string) {
		const completion = name === "tree-open" ? "tree-confirm" : name.replace(/-open$/, "");
		this.recording = loadFixtureRecording(completion);
		const initial = loadFixtureRecording(name);
		const inputs = this.recording.inputs.filter(input => "keys" in input || input.body.ev !== "send");
		if (name.startsWith("hook-")) {
			const candidates = inputs.filter(input => !("keys" in input) && ["activate", "edit", "action"].includes(input.body.ev));
			const edit = candidates.findLastIndex(input => !("keys" in input) && input.body.ev === "edit");
			this.expected = name.endsWith("-cancel") ? candidates.slice(-1) : edit >= 0 ? candidates.slice(edit) : candidates;
		} else this.expected = inputs;
		if (!this.expected.length) throw new Error(`Missing accepted completion input for ${name}`);
		const boundary = this.expected[0]!.afterMessage;
		if (name.endsWith("-open")) {
			// Open-only captures have their own frame batching; show their final pre-close document.
			const close = initial.messages.findIndex(message => message.verb === "x");
			this.advanceTo(close < 0 ? initial.messages.length : close, initial.messages);
		} else if (boundary !== undefined) this.advanceTo(boundary, initial.messages);
		else {
			while (this.cursor < initial.messages.length && !hasRecordedMenu(this.documents)) this.advanceTo(this.cursor + 1, initial.messages);
		}
		if (!hasRecordedMenu(this.documents)) throw new Error(`Missing recorded menu before ${name}'s next input`);
	}
	snapshot(): TspHostSnapshot { return fixtureSnapshot(this.documents, this.name === "import-claude" ? 0 : 1, this.#revision); }
	advanceTo(boundary: number, messages = this.recording.messages): void {
		if (boundary > messages.length) throw new Error(`Missing program responses for ${this.name} at message ${boundary}`);
		while (this.cursor < boundary) {
			const message = messages[this.cursor++]!;
			this.documents.receive({ verb: message.verb, body: JSON.stringify(message.body) });
			this.#revision++;
		}
	}
	finish(): void {
		if (this.name.endsWith("-open")) {
			// Accepted responses belong to the completion recording, not the open-only capture's sequence.
			this.documents = new FixtureDocuments();
			this.cursor = 0;
			this.#revision++;
			const boundary = this.expected[0]!.afterMessage;
			if (boundary !== undefined) this.advanceTo(boundary);
			else while (this.cursor < this.recording.messages.length && !hasRecordedMenu(this.documents)) this.advanceTo(this.cursor + 1);
		}
		while (this.cursor < this.recording.messages.length && hasRecordedMenu(this.documents)) this.advanceTo(this.cursor + 1);
		expect(hasRecordedMenu(this.documents), `${this.name} leaves its recorded menu`).toBe(false);
	}
}
const feedbackCases = [
	["move-success", "/move /tmp/vomp-fixture/destination", "Moved to /tmp/vomp-fixture/destination"],
	["worktree-exit-ask", "/wt fixture", "Moved to worktree /tmp/vomp-fixture/home/tmp/vomp-fixture/agent/wt/fixture-d54ba38"],
	["clear-success", "/clear", "4 messages dropped; session continues."],
	["ssh-add", "/ssh add fixture --host example.invalid", 'Added SSH host "fixture"'],
	["ssh-remove", "/ssh remove fixture", 'Removed SSH host "fixture"'],
	["mcp-reload", "/mcp reload", "MCP reload complete"],
	["extension-throw", "/audit-feedback-throw", "Public fixture extension failure"],
	["stats-source-shaped", "/stats", "http://127.0.0.1:51239/"],
	["oauth-source-shaped", "/mcp reauth fixture", "Alternative if browser did not open:"],
] as const;
function feedbackResults(name: string, command: string): GateResultRow[] {
	const documents = new FixtureDocuments();
	const collector = new TspMainFeedback();
	const rows = new Map<string, GateResultRow>();
	const accept = (before: TspHostSnapshot, after: TspHostSnapshot[]) => {
		collector.begin(before, (output, snapshot) => {
			rows.set(output.nodeId, { id: output.nodeId, command, lines: (output.resultText ?? output.text).split("\n"), tone: output.tone, locations: output.locations,
				anchor: null, room: "gate", createdAt: Date.UTC(2026, 10, 9, 16),
				provenance: [{ hostId: snapshot.hostId, epoch: snapshot.epoch, generation: snapshot.generation, surfaceId: output.surfaceId, nodeId: output.nodeId, text: output.fingerprint }] });
			return true;
		});
		for (const snapshot of after) collector.apply(snapshot);
	};
	if (name.endsWith("-source-shaped")) {
		// Source-shaped public examples. Authenticated OAuth and /stats were not recorded.
		const url = name === "stats-source-shaped" ? "http://127.0.0.1:51239/" : "https://auth.example.invalid/authorize?client_id=public-fixture&state=fixture-state&scope=read%20write";
		const nodes: TspNode[] = name === "stats-source-shaped" ? [
			{ id: "stats", k: "row", c: [
				{ id: "stats/message", k: "text", p: { role: "omp.stats", text: `Stats dashboard: ${url}` } },
				{ id: "stats/open", k: "button", p: { text: "Open dashboard ↗", href: url, actions: { click: "open" } } },
				{ id: "stats/note", k: "text", p: { text: "Sessions sync in the background." } },
			] },
		] : [{ id: "oauth", k: "col", c: [
			{ id: "oauth/wait", k: "text", p: { text: "Waiting for authorization... (Press Esc to cancel, 5 minute timeout)" } },
			{ id: "oauth/manual", k: "text", p: { text: "Headless? Paste the redirect URL or code with /login <value>." } },
			{ id: "oauth/fallback", k: "text", p: { text: "Alternative if browser did not open:" } },
			{ id: "oauth/link", k: "text", p: { text: "Click here to authorize", href: url, actions: { click: "open", menu: ["open", "copy"] } } },
		] }];
		const before: TspHostSnapshot = { hostId: "gate", generation: 1, epoch: 1, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null, availability: { available: true, reason: null }, surfaces: [
			{ open: { id: "s:1", mode: "inline", role: "omp.session" }, documentGeneration: 1, sequence: 1, closed: false, suspended: false, settled: [], focus: null, document: { id: "s:1", k: "col", c: [{ id: "main", k: "col" }] } },
		] };
		const after = { ...before, revision: 2, surfaces: before.surfaces.map(surface => ({ ...surface, sequence: 2, document: { ...surface.document, c: [{ id: "main", k: "col" as const, c: nodes }] } })) };
		accept(before, [after]);
	} else {
		const { messages, start, end } = loadCommandFeedbackRecording(name, command);
		for (const message of messages.slice(0, start)) documents.receive({ verb: message.verb, body: JSON.stringify(message.body) });
		const before = fixtureSnapshot(documents);
		const after: TspHostSnapshot[] = [];
		for (const message of messages.slice(start, end)) {
			if (message.verb === "x") break;
			documents.receive({ verb: message.verb, body: JSON.stringify(message.body) });
			after.push(fixtureSnapshot(documents, 1, after.length + 2));
		}
		accept(before, after);
	}
	return [...rows.values()];
}

describe.skipIf(process.env.TSP_UI_GATE !== "1")("recorded omp screen in headless Chrome", () => {
	let vite: ViteDevServer;
	let child: ChildProcess;
	let profile: string;
	let page: ChromePage;
	let shots: string;
	beforeAll(async () => {
		if (!existsSync(chrome)) throw new Error(`Chrome is required for TSP_UI_GATE=1. Set CHROME_BIN to its executable: ${chrome}`);
		shots = process.env.TSP_GATE_SHOTS ?? join(homedir(), "vomp-checks/ask-18185/chrome");
		profile = await mkdtemp(join(tmpdir(), "vomp-chrome-gate-"));
		await mkdir(shots, { recursive: true });
		vite = await createServer({ configFile: false, root, cacheDir: join(profile, "vite-cache"), plugins: [...formLayoutBaseline(), react(), tailwindcss()], resolve: { dedupe: ["react", "react-dom"], alias: { "@shared": resolve(root, "src/shared"), "@": resolve(root, "src/renderer/src"), "@oh-my-pi/pi-wire": resolve(root, "src/renderer/src/collab/wire/index.ts"), "@oh-my-pi/pi-utils/marked": "marked", "@oh-my-pi/pi-utils/math-delimiters": resolve(root, "src/renderer/src/collab/math-delimiters.ts") } }, server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root, realpathSync(resolve(root, "node_modules"))] } } });
		await vite.listen();
		child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
		const started = Promise.withResolvers<string>();
		let output = "";
		// The deadline guards a real subprocess; fake timers cannot start Chrome.
		const timer = setTimeout(() => started.reject(new Error(`Chrome did not start: ${output}`)), 20_000);
		child.once("error", error => { clearTimeout(timer); started.reject(error); });
		child.stderr!.on("data", bytes => { output += String(bytes); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); started.resolve(match[1]!); } });
		const endpoint = await started.promise;
		const base = new URL(endpoint);
		const target = z.object({ webSocketDebuggerUrl: z.string() }).parse(await fetch(`http://${base.host}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5_000) }).then(response => response.json()));
		const socket = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 5_000 }); await once(socket, "open");
		page = new ChromePage(socket);
		await page.send("Page.enable");
		await page.send("Network.enable");
		await page.send("Runtime.enable");
		await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
		await page.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 620, deviceScaleFactor: 1, mobile: false });
		await page.send("Page.navigate", { url: `${vite.resolvedUrls!.local[0]}src/renderer/src/features/tsp/testing/gate.html` });
		await page.until("!!window.gate");
	}, 60_000);
	afterAll(async () => {
		try { page?.close(); await stopChrome(child); }
		finally {
			try { await vite?.close(); }
			finally { if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
		}
	});

	it.each((["layer", "dock"] as const).flatMap(placement => (["transient", "driven", "leftover", "requested", "persistent"] as const).map(mode => ({ placement, mode }))))("replays recorded model-picker $placement policy $mode without a screen flash", async ({ placement, mode }) => {
		const recording = loadFixtureRecording(mode === "persistent" || mode === "requested" ? "model-picker" : "model-switch");
		const documents = new FixtureDocuments();
		const frames: TspHostSnapshot[] = [];
		for (const message of recording.messages) {
			documents.receive({ verb: message.verb, body: JSON.stringify(message.body) });
			if (message.verb === "f") frames.push(fixtureSnapshot(documents));
		}
		const hasPicker = (frame: TspHostSnapshot) => frame.surfaces.some(surface => [...walkNodes(surface.document)].some(node => node.k === "picker" && node.p?.noun === "models"));
		const index = frames.findIndex(hasPicker);
		expect(index).toBeGreaterThan(0);
		const idle = frames[index - 1]!;
		const shown = structuredClone(frames[index]!);
		const closed = frames.slice(index + 1).find(frame => !hasPicker(frame))!;
		expect(closed).toBeDefined();
		if (placement === "dock") {
			const surface = shown.surfaces.find(surface => [...walkNodes(surface.document)].some(node => node.k === "picker" && node.p?.noun === "models"))!;
			const layer = surface.document.c!.find(node => node.id === "layer")!;
			const picker = layer.c!.find(node => node.k === "picker" && node.p?.noun === "models")!;
			expect(picker).toBeDefined();
			layer.c = layer.c!.filter(node => node !== picker);
			const dock = surface.document.c!.find(node => node.id === "dock")!;
			const slot = dock.c!.find(node => node.k === "col" && !node.p?.role)!;
			expect(slot).toBeDefined();
			slot.c = [...(slot.c ?? []), picker];
		}
		await page.evaluate(`document.documentElement.dataset.motion='reduced'; window.gate.showAutomatic(${JSON.stringify(idle)})`);
		if (mode === "driven" || mode === "leftover" || mode === "requested") await page.evaluate(`window.gate.beginScreenActivity(${JSON.stringify(mode === "requested" ? "request" : "drive")})`);
		const shownAt = await page.evaluate<number>(`(() => { const at=performance.now(); window.gate.update(${JSON.stringify(shown)}); return at; })()`);
		let releaseAt: number | null = null;
		if (mode === "transient") {
			await delay(150);
			await page.evaluate(`window.gate.update(${JSON.stringify(closed)})`);
			await delay(450);
		} else if (mode === "driven" || mode === "leftover") {
			await delay(650);
			expect(await page.evaluate("window.gate.formPresentationEvents.filter(event => event.terminalTabId !== null)")).toEqual([]);
			if (mode === "driven") await page.evaluate(`window.gate.update(${JSON.stringify(closed)})`);
			releaseAt = await page.evaluate<number>("(() => { const at=performance.now(); window.gate.endScreenActivity(); return at; })()");
			await delay(400);
		} else if (mode === "persistent") {
			// Repainting unsolicited content must never become a request to open it.
			for (let repaint = 0; repaint < 4; repaint++) {
				await delay(100);
				for (const surface of shown.surfaces) surface.sequence++;
				await page.evaluate(`window.gate.update(${JSON.stringify(shown)})`);
			}
			expect(await page.evaluate("window.gate.formPresentationEvents.filter(event => event.terminalTabId !== null)")).toEqual([]);
		} else await page.until("!!document.querySelector('.tsp-screen')");
		const openings = await page.evaluate<{ at: number; terminalTabId: string }[]>("window.gate.formPresentationEvents.filter(event => event.terminalTabId !== null)");
		if (mode !== "requested") expect(openings).toEqual([]);
		else {
			expect(openings).toHaveLength(1);
			expect(openings[0]!.at - shownAt).toBeLessThan(250);
		}
		await page.evaluate(`window.gate.endScreenActivity(); window.gate.update(${JSON.stringify(closed)})`);
		await page.until("!document.querySelector('.tsp-screen')");
		const events = await page.evaluate("window.gate.formPresentationEvents");
		expect(await page.evaluate("window.gate.calls")).toEqual([]);
		await writeFile(join(shots, `model-picker-${placement}-${mode}.json`), JSON.stringify({ recording: mode === "persistent" || mode === "requested" ? "model-picker" : "model-switch", placement, mode, shownAt, releaseAt, events, seam: "Production OverlayWatcher, exact-scope interaction registry and semantic sheet; recorded picker frames, with dock placement matching the owner's live layout." }, null, 2));
	}, 30_000);

	it("keeps rate-limit errors and task output out of the omp screen until explicitly requested", async () => {
		const snapshot: TspHostSnapshot = {
			hostId: "gate", generation: 1, epoch: 1, revision: 1, negotiated: true,
			lifecycle: "live", documentGeneration: 1, failure: null,
			availability: { available: true, reason: null },
			surfaces: [{
				open: { id: "s:1", mode: "screen" }, documentGeneration: 1,
				sequence: 1, closed: false, suspended: false, settled: [], focus: null,
				document: { id: "s:1", k: "col", c: [{ id: "main", k: "col", c: [
					{ id: "error", k: "text", p: { text: "429 rate_limit_error: Please try again later." } },
					{ id: "tasks", k: "text", p: { text: "8 of 13 tasks complete" } },
				] }] },
			}],
		};
		await page.evaluate(`window.gate.showAutomatic(${JSON.stringify(snapshot)})`);
		await delay(1000);
		expect(await page.evaluate("window.gate.formPresentationEvents.filter(event => event.terminalTabId !== null)")).toEqual([]);
		expect(await page.evaluate("!!document.querySelector('.tsp-screen')")).toBe(false);
		const closedCapture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(shots, "unsolicited-error-screen-closed.png"), Buffer.from(closedCapture.data, "base64"));
		await page.evaluate("window.gate.beginScreenActivity('request')");
		await page.until("!!document.querySelector('.tsp-screen')");
		expect(await page.evaluate("document.querySelector('.tsp-screen').textContent")).toContain("429 rate_limit_error");
		const requestedCapture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(shots, "requested-error-screen-open.png"), Buffer.from(requestedCapture.data, "base64"));
		await page.evaluate("window.gate.endScreenActivity()");
	}, 30_000);

	it.each(["full", "reduced", "system"] as const)("shows requested omp content at rest on its first frame with %s motion", async motion => {
		const documents = new FixtureDocuments();
		const frames: TspHostSnapshot[] = [];
		for (const message of loadFixtureRecording("model-picker").messages) {
			documents.receive({ verb: message.verb, body: JSON.stringify(message.body) });
			if (message.verb === "f") frames.push(fixtureSnapshot(documents));
		}
		const hasPicker = (frame: TspHostSnapshot) => frame.surfaces.some(surface => [...walkNodes(surface.document)].some(node => node.k === "picker" && node.p?.noun === "models"));
		const index = frames.findIndex(hasPicker);
		expect(index).toBeGreaterThan(0);
		const shown = frames[index]!;
		const closed = frames.slice(index + 1).find(frame => !hasPicker(frame))!;
		await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
		try {
			await page.evaluate(`document.documentElement.dataset.motion=${JSON.stringify(motion)}; ${motion === "system" ? "delete document.documentElement.dataset.motion;" : ""} window.gate.showAutomatic(${JSON.stringify(frames[index - 1])})`);
			await page.evaluate("window.gate.beginScreenActivity('request')");
			const first = await page.evaluate<{ animation: string; opacity: string; translate: string; top: number; bottom: number; viewport: number }>(`(() => {
				const { promise, resolve } = Promise.withResolvers();
				const sample = () => {
					const content = document.querySelector('.tsp-screen');
					if (!content) { requestAnimationFrame(sample); return; }
					const style = getComputedStyle(content.closest('.vo-sheet'));
					const rect = content.getBoundingClientRect();
					resolve({ animation: style.animationName, opacity: style.opacity, translate: style.translate, top: rect.top, bottom: rect.bottom, viewport: innerHeight });
				};
				requestAnimationFrame(sample);
				window.gate.update(${JSON.stringify(shown)});
				return promise;
			})()`);
			expect(first.animation).toBe("none");
			expect(first.opacity).toBe("1");
			expect(first.translate).toBe("none");
			expect(first.top).toBeGreaterThanOrEqual(0);
			expect(first.bottom).toBeLessThanOrEqual(first.viewport);
			const otherSheet = await page.evaluate<string>(`(() => {
				const sheet = document.querySelector('.vo-sheet');
				sheet.classList.remove('omp-screen-sheet');
				const animation = getComputedStyle(sheet).animationName;
				sheet.classList.add('omp-screen-sheet');
				return animation;
			})()`);
			expect(otherSheet).toContain(motion === "full" ? "vo-slide-in-bottom" : "vo-fade-in");
			await writeFile(join(shots, `requested-screen-first-frame-${motion}.json`), JSON.stringify({ first, otherSheet }, null, 2));
		} finally {
			await page.evaluate(`window.gate.endScreenActivity(); window.gate.update(${JSON.stringify(closed)})`);
			await page.until("!document.querySelector('.tsp-screen')");
			await page.send("Emulation.setEmulatedMedia", { features: [] });
		}
	}, 30_000);

	it.each(feedbackCases.flatMap(([name, command, expected]) => (["light", "dark"] as const).map(theme => ({ name, command, expected, theme }))))("renders command Result $name in $theme without an omp screen", async ({ name, command, expected, theme }) => {
		const rows = feedbackResults(name, command);
		expect(rows.some(row => row.lines.join("\n").includes(expected) || row.locations?.some(location => location.value === expected))).toBe(true);
		await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.dataset.motion='reduced'; window.gate.showCommandResults(${JSON.stringify(rows)});`);
		await page.until(`!!document.querySelector('section[aria-label="Command feedback"]') && document.body.textContent.includes(${JSON.stringify(expected)})`);
		await page.evaluate("document.fonts.ready.then(() => true)");
		expect(await page.evaluate("!!document.querySelector('.tsp-screen')")).toBe(false);
		expect(await page.evaluate(`document.querySelector('section[aria-label="Command feedback"]').textContent.split(${JSON.stringify(command)}).length - 1`)).toBe(rows.length);
		expect(await page.evaluate("[...document.querySelectorAll('section[aria-label=\"Command feedback\"] button')].every(button => button.getBoundingClientRect().right <= innerWidth)")).toBe(true);
		if (name === "stats-source-shaped") {
			expect(rows[0]!.lines).toEqual([`Stats dashboard: ${expected}`, "Sessions sync in the background."]);
			expect(await page.evaluate("document.querySelector('section[aria-label=\"Command feedback\"] pre').textContent")).not.toContain("Open dashboard");
			expect(await page.evaluate("document.querySelector('section[aria-label=\"Command feedback\"] li code').textContent")).toBe(expected);
			await page.evaluate("window.statsCopied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.statsCopied = text; } } });");
			await page.clickElement("[...document.querySelectorAll('section[aria-label=\"Command feedback\"] button')].find(button => button.textContent === 'Copy URL')");
			expect(await page.evaluate("window.statsCopied")).toBe(expected);
		}
		const screenshot = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(shots, `command-${name}-${theme}.png`), Buffer.from(screenshot.data, "base64"));
	}, 30_000);
	it.each((process.platform === "darwin" ? ["mac-alias", "symlink"] : ["symlink"]).flatMap(kind => ["light", "dark"].map(theme => ({ kind, theme }))))("links spaced reply files through canonical project identity in $theme for $kind", async ({ theme, kind }) => {
		const root = realpathSync(await mkdtemp(join(tmpdir(), "vomp-reply-files-")));
		try {
			const canonicalProject = kind === "symlink" ? join(root, "real-project") : root;
			if (kind === "symlink") await mkdir(canonicalProject);
			const project = kind === "symlink" ? join(root, "opened-project") : root.replace(/^\/private(?=\/var\/)/, "");
			if (kind === "symlink") await symlink(canonicalProject, project, process.platform === "win32" ? "junction" : "dir");
			const folder = join(canonicalProject, "ReadyCloud Files", "ReadyReturns Chat Demos", "Videos");
			await mkdir(folder, { recursive: true });
			const names = ["FootLocker Return Chat v2.mp4", "Dicks Sporting Goods Return Chat.mp4"];
			const paths = names.map(name => join(folder, name));
			for (const other of ["one", "two"]) {
				await mkdir(join(root, other));
				paths.push(join(root, other, "Shared Return Chat.mp4"));
			}
			for (const path of paths) await writeFile(path, "file-reference fixture");
			const text = "I've rendered both videos. They're in `ReadyCloud Files/ReadyReturns Chat Demos/Videos/`:\n\n- `FootLocker Return Chat v2.mp4`\n- `Dicks Sporting Goods Return Chat.mp4`\n\nAmbiguous: `Shared Return Chat.mp4`. Missing: `Missing Return Chat.mp4`.";
			const entries: SessionEntry[] = [{ id: "file-user", parentId: null, timestamp: "2026-11-09T20:00:00Z", type: "message", message: { role: "user", content: "Render the video fixtures.", timestamp: 1 } }];
			const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
			entries.push({ id: "file-calls", parentId: null, timestamp: "2026-11-09T20:00:01Z", type: "message", message: { role: "assistant", content: paths.map((path, index) => ({ type: "toolCall", id: `file-${index}`, name: "write", arguments: { path, content: "fixture" } })), model: "fixture", usage, stopReason: "toolUse", timestamp: 2 } });
			paths.forEach((path, index) => entries.push({ id: `file-result-${index}`, parentId: null, timestamp: "2026-11-09T20:00:02Z", type: "message", message: { role: "toolResult", toolCallId: `file-${index}`, toolName: "write", content: [{ type: "text", text: "Written." }], details: { resolvedPath: path }, isError: false, timestamp: 3 + index } }));
			entries.push({ id: "file-reply", parentId: null, timestamp: "2026-11-09T20:00:03Z", type: "message", message: { role: "assistant", content: [{ type: "text", text }], model: "fixture", usage, stopReason: "stop", timestamp: 10 } });
			await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.dataset.motion='reduced'; window.gate.showReplyFiles(${JSON.stringify(entries)}, ${JSON.stringify(project)});`);
			await page.until("window.gate.fileRequests.length === 2");
			const requests = await page.evaluate<FileRefRequest[]>("window.gate.fileRequests.map(item => item.request)");
			const rootRequests = requests.filter(request => request.refs.length === 1 && request.refs[0] === project && request.bases.length === 0);
			expect(rootRequests).toHaveLength(1);
			const request = requests.find(request => request.refs[0] === "ReadyCloud Files/ReadyReturns Chat Demos/Videos/")!;
			expect(request.refs).toEqual(["ReadyCloud Files/ReadyReturns Chat Demos/Videos/", ...names, "Shared Return Chat.mp4", "Missing Return Chat.mp4"]);
			expect(new Set((request.files ?? []).map(path => realpathSync(path)))).toEqual(new Set(paths));
			for (const [index, request] of requests.entries()) {
				const resolved = await resolveFileRefs(request, root);
				if (request === rootRequests[0]) expect(resolved).toEqual([{ path: canonicalProject, kind: "folder" }]);
				await page.evaluate(`window.gate.resolveFiles(${index}, ${JSON.stringify(resolved)});`);
			}
			const expectedLabels = names.map(name => `ReadyCloud Files/ReadyReturns Chat Demos/Videos/${name}`);
			await page.until(`JSON.stringify([...document.querySelectorAll('.tr-file-row .tr-file-folder')].map(row => row.textContent)) === ${JSON.stringify(JSON.stringify(expectedLabels))}`);
			expect(await page.evaluate("[...document.querySelectorAll('.tr-file-row')].map(row => row.dataset.filePath)")).toEqual(paths.slice(0, 2));
			expect(await page.evaluate("[...document.querySelectorAll('.tr-file-row .tr-file-folder')].map(row => row.textContent)")).toEqual(expectedLabels);
			expect(await page.evaluate("[...document.querySelectorAll('.tr-file-row')].map(row => row.title)")).toEqual(paths.slice(0, 2));
			expect(await page.evaluate("!!document.querySelector('.tr-file-list') && !!document.querySelector('.tr-file-chip[data-file-kind=\"folder\"]')")).toBe(true);
			expect(await page.evaluate("[...document.querySelectorAll('.tr-md code')].filter(code => /^(Shared|Missing) Return Chat\\.mp4$/.test(code.textContent)).length")).toBe(2);
			await page.evaluate("document.fonts.ready.then(() => true)");
			for (const [index, path] of paths.slice(0, 2).entries()) {
				await page.clickElement(`document.querySelectorAll('.tr-file-row')[${index}]`);
				expect(await page.evaluate("window.gate.fileViewer()")).toEqual({ path, pane: "files" });
			}
			await page.evaluate("window.pathCopied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.pathCopied = text; } } }); document.querySelector('.tr-file-row').focus();");
			await page.key("F10", "F10", 8);
			await page.until("[...document.querySelectorAll('[role=\"menuitem\"]')].some(item => item.textContent === 'Copy path')");
			await page.clickElement("[...document.querySelectorAll('[role=\"menuitem\"]')].find(item => item.textContent === 'Copy path')");
			expect(await page.evaluate("window.pathCopied")).toBe(paths[0]);
			await page.until("!document.querySelector('[role=\"menu\"]')");
			const capture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(shots, `reply-files-${kind}-${theme}.png`), Buffer.from(capture.data, "base64"));
			await page.clickElement("[...document.querySelectorAll('button')].find(button => button.textContent.startsWith('Changed 4 files'))");
			await page.until("document.querySelectorAll('button[data-context-path][data-context-changes]').length === 4");
			const summary = await page.evaluate<{ path: string; label: string; title: string }[]>("[...document.querySelectorAll('button[data-context-path][data-context-changes]')].map(button => ({ path: button.dataset.contextPath, label: button.textContent, title: button.title }))");
			for (const file of summary) {
				expect(file.title).toBe(file.path);
				const canonicalPath = realpathSync(file.path);
				const inside = canonicalPath.startsWith(`${canonicalProject}${process.platform === "win32" ? "\\" : "/"}`);
				expect(file.label).toContain(inside ? canonicalPath.slice(canonicalProject.length + 1).replace(/\\/g, "/") : file.path);
				if (inside) expect(file.label).not.toContain(canonicalProject);
			}
			await page.until("window.gate.buttonVisible([...document.querySelectorAll('button[data-context-path][data-context-changes]')].at(-1))");
			const summaryCapture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(shots, `reply-files-summary-${kind}-${theme}.png`), Buffer.from(summaryCapture.data, "base64"));
		} finally { await rm(root, { recursive: true, force: true }); }
	}, 60_000);
	it.each([360, 1400].flatMap(width => ["light", "dark"].map(theme => ({ width, theme }))))("keeps table tokens readable at $width pixels in $theme", async ({ width, theme }) => {
		await page.send("Emulation.setDeviceMetricsOverride", { width: width + 64, height: 800, deviceScaleFactor: 1, mobile: false });
		const path = `/workspace/${"long-project-folder/".repeat(30)}report.json`;
		const url = `https://example.invalid/${"long-resource-name/".repeat(30)}report`;
		for (const name of ["tools", "changelog", "assistant"]) {
			if (name === "assistant") {
				const text = `## Project files\n\n| Tool | Location |\n| --- | --- |\n| \`read\` | \`${path}\` |\n| [docs](https://example.invalid/docs) | [${url}](${url}) |\n| \`grep\` | Regular words can wrap between words. |`;
				await page.evaluate(`window.gate.showMarkdown(${JSON.stringify(text)});`);
			} else {
				const snapshot = structuredClone(commandPanelFrames(name).findLast(frame => frame.surfaces.some(surface => [...walkNodes(surface.document)].some(node => commandReport(node))))!);
				snapshot.hostId = "gate";
				const node = snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]).find(item => commandReport(item))!;
				const report = commandReport(node)!;
				const row = { id: `${name}-${width}-${theme}`, command: `/${name}`, title: report.title, lines: report.lines, markdown: report.markdown, tone: "info", anchor: null, room: "gate", createdAt: Date.UTC(2026, 10, 9, 16) };
				await page.evaluate(`window.gate.update(${JSON.stringify(snapshot)}); window.gate.showCommandResults(${JSON.stringify([row])});`);
			}
			const label = name === "assistant" ? "Assistant message" : "Command feedback";
			await page.until(`!!document.querySelector('section[aria-label="${label}"] .tr-md')`);
			await page.evaluate(`(() => { document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.dataset.motion='reduced'; const section = document.querySelector('section[aria-label="${label}"]'); section.style.maxWidth='none'; section.style.width='${width}px'; document.querySelector('main').scrollTop=0; })()`);
			await page.evaluate("document.fonts.ready.then(() => true)");
			expect(await page.evaluate(`document.querySelector('section[aria-label="${label}"]').getBoundingClientRect().width`)).toBe(width);
			expect(await page.evaluate("document.body.scrollWidth <= innerWidth")).toBe(true);
			if (name !== "changelog") {
				const short = await page.evaluate<{ text: string; rows: number; marked: boolean }[]>(`[...document.querySelectorAll('section[aria-label="${label}"] tbody td:first-child :is(code,a)')].map(element => { const range = document.createRange(); range.selectNodeContents(element); return { text: element.textContent, rows: new Set([...range.getClientRects()].map(rect => Math.round(rect.y))).size, marked: element.hasAttribute('data-wrap-long') }; })`);
				expect(short.length).toBeGreaterThan(0);
				for (const token of short) expect(token, `${name} ${width} ${token.text}`).toMatchObject({ rows: 1, marked: false });
			}
			if (name === "assistant") {
				const layout = await page.evaluate<{ scrolls: boolean; wrapped: number[]; path: string; href: string; label: string }>("(() => { const root = document.querySelector('section[aria-label=\"Assistant message\"]'); const frame = root.querySelector('.tr-table'); return { scrolls: frame.scrollWidth > frame.clientWidth + 1, wrapped: [...root.querySelectorAll('[data-wrap-long]')].map(element => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects().length; }), path: root.querySelector('td:nth-child(2) code').textContent, href: root.querySelector('a[data-wrap-long]').getAttribute('href'), label: root.querySelector('a[data-wrap-long]').textContent }; })()");
				expect(layout.scrolls).toBe(false);
				expect(layout.wrapped).toHaveLength(2);
				expect(layout.wrapped.every(lines => lines > 1)).toBe(true);
				expect(layout.path).toBe(path); expect(layout.href).toBe(url); expect(layout.label).toBe(url);
			}
			const capture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(shots, `table-${name}-${width}-${theme}.png`), Buffer.from(capture.data, "base64"));
			if (name === "tools") {
				await page.evaluate("(() => { const code = [...document.querySelectorAll('tbody td:first-child code')].find(element => element.textContent === 'glob'); code.scrollIntoView({block:'start'}); })()");
				const focused = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
				await writeFile(join(shots, `table-tools-tokens-${width}-${theme}.png`), Buffer.from(focused.data, "base64"));
			}
		}
		await page.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 620, deviceScaleFactor: 1, mobile: false });
	}, 60_000);
	it.each(["light", "dark"])("presents command panels and reports in %s without losing their text", async theme => {
		for (const name of ["tools", "changelog", "jobs-full", "advisor-status", "ssh-list", "ssh-help", "mcp-help", "mcp-list", "mcp-resources", "mcp-prompts", "mcp-notifications", "cleanse", "omfg-error-panel", "omfg-saved-source-shaped", "cleanse-clean-source-shaped", "cleanse-unresolved-source-shaped", "cleanse-cancelled-source-shaped", "cleanse-error-source-shaped"]) {
			const source = name.startsWith("omfg-") ? "omfg-error-panel" : name.startsWith("cleanse-") ? "cleanse" : name;
			const snapshot = structuredClone(commandPanelFrames(source).findLast(frame => frame.surfaces.some(surface => [...walkNodes(surface.document)].some(node => commandReport(node) || settledCommandPanel(node))))!);
			snapshot.hostId = "gate";
			const surface = snapshot.surfaces[0]!;
			const node = [...walkNodes(surface.document)].find(item => item.p?.role === "omp.overlay.report" || item.p?.role === "omp.overlay.cleanse" || item.p?.role === "omp.overlay.omfg")!;
			if (name === "omfg-saved-source-shaped") {
				const path = "/tmp/vomp-fixture/.omp/rules/use-context.md";
				replacePanelChild(node, 1, { id: "saved-status", k: "text", p: { text: `Saved ${path}` } });
				replacePanelChild(node, 2, { id: "candidate", k: "md", p: { text: "# Use context\nConsult the project instructions before editing." } });
				replacePanelChild(node.c!.at(-1)!, 0, { id: "saved-outcome", k: "text", p: { text: `Registered live · ${path}` } });
			}
			if (name.startsWith("cleanse-")) {
				const outcome = name.includes("unresolved") ? "Diagnostics remain" : name.includes("cancelled") ? "Cancelled" : name.includes("error") ? "Error" : "Clean";
				replacePanelChild(node, 1, { id: "checker-details", k: "text", p: { text: outcome === "Clean" ? "Checker completed without diagnostics." : outcome === "Error" ? "Fixture checker failed." : outcome === "Cancelled" ? "Checker stopped." : "Checker reported unresolved diagnostics." } });
				replacePanelChild(node.c!.at(-1)!, 0, { id: "checker-outcome", k: "text", p: { text: outcome } });
			}
			const report = commandReport(node);
			const panel = settledCommandPanel(node);
			expect(!!report || !!panel, name).toBe(true);
			const row = { id: name, command: panel?.command ?? `/${name.replace("-full", " full").replace("-", " ")}`, title: report?.title, lines: report?.lines ?? panel!.lines, tone: panel?.status === "error" ? "err" : panel?.status === "warning" || panel?.status === "cancelled" ? "warn" : "info", anchor: null, room: "gate", createdAt: Date.UTC(2026, 10, 9, 16),
				markdown: report?.markdown,
				...(panel?.path ? { locations: [{ kind: "path", value: panel.path }] } : {}),
				panel: { hostId: "gate", epoch: snapshot.epoch, generation: 1, surfaceId: surface.open.id, nodeId: node.id, text: JSON.stringify(node), ...(report ? { close: report.close } : {}) } };
			await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.dataset.motion='reduced'; window.gate.update(${JSON.stringify(snapshot)}); window.gate.showCommandResults(${JSON.stringify([row])});`);
			await page.until(`!!document.querySelector('section[aria-label="Command feedback"]') && document.body.textContent.includes(${JSON.stringify(report?.title ?? panel!.lines[0])})`);
			await page.evaluate("document.fonts.ready.then(() => true)");
			expect(await page.evaluate("!!document.querySelector('.tsp-screen')")).toBe(false);
			if (report) {
				await page.until("window.gate.calls.length === 1");
				expect(await page.evaluate("window.gate.calls[0].args[2].act")).toBe("close");
			}
			if (name === "tools" || name === "changelog") {
				expect(report?.markdown).toBe(true);
				await page.until("!!document.querySelector('section[aria-label=\"Command feedback\"] .tr-md')");
				if (name === "tools") expect(await page.evaluate("document.querySelector('section[aria-label=\"Command feedback\"] .tr-md table th')?.textContent")).toBe("Tool");
				else expect(await page.evaluate("!!document.querySelector('section[aria-label=\"Command feedback\"] .tr-md h2') && !!document.querySelector('section[aria-label=\"Command feedback\"] .tr-md h3')")).toBe(true);
				expect(await page.evaluate("document.querySelector('section[aria-label=\"Command feedback\"] .tr-md').parentElement.getBoundingClientRect().height <= 384")).toBe(true);
			}
			expect(await page.evaluate("document.body.scrollWidth <= innerWidth")).toBe(true);
			const capture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(shots, `panel-${name}-${theme}.png`), Buffer.from(capture.data, "base64"));
			if (name === "tools" || name === "changelog") {
				await page.evaluate("window.reportCopied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.reportCopied = text; } } });");
				await page.clickElement("document.querySelector('button[aria-label=\"Copy result\"]')");
				expect(await page.evaluate("window.reportCopied")).toBe(row.lines.join("\n"));
				await page.clickElement("[...document.querySelectorAll('section[aria-label=\"Command feedback\"] button')].find(button => button.textContent === 'Show full report')");
				expect(await page.evaluate("document.querySelector('section[aria-label=\"Command feedback\"] .tr-md').parentElement.classList.contains('max-h-96')")).toBe(false);
			}
		}
		for (const name of ["cleanse", "omfg-error-panel"]) {
			const snapshot = structuredClone(commandPanelFrames(name).find(frame => frame.surfaces.some(surface => [...walkNodes(surface.document)].some(node => node.k === "spinner" && node.id.includes(name === "cleanse" ? "head" : "j.0"))))!);
			snapshot.hostId = "gate";
			await page.evaluate(`window.gate.showCommandResults([]); window.gate.open(${JSON.stringify(snapshot)});`);
			if (name === "cleanse") await page.evaluate("import('/src/renderer/src/state/app.ts').then(({ useApp }) => useApp.getState().openTerminal('gate'))");
			await page.until("!!document.querySelector('.tsp-screen')");
			await page.until("(document.querySelector('.vo-sheet')?.getBoundingClientRect().bottom ?? Infinity) <= innerHeight");
			await page.until("(() => { for (let element = document.querySelector('.vo-sheet'); element; element = element.parentElement) if (Number(getComputedStyle(element).opacity) < 1) return false; return true; })()");
			await page.evaluate("document.fonts.ready.then(() => true)");
			const capture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(shots, `panel-${name}-progress-${theme}.png`), Buffer.from(capture.data, "base64"));
			await close();
		}
	}, 120_000);
	async function open(snapshot: TspHostSnapshot, theme = "light", scale = 100, reduced = true) {
		await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.dataset.motion=${JSON.stringify(reduced ? "reduced" : "full")}; document.documentElement.style.fontSize=${JSON.stringify(`${scale}%`)}; window.gate.open(${JSON.stringify(snapshot)});`);
		await page.until("!!document.querySelector('.tsp-screen') && document.querySelector('.tsp-screen').contains(document.activeElement)");
		await page.evaluate("document.fonts.ready.then(() => true)");
		await page.until("(document.querySelector('.vo-sheet')?.getBoundingClientRect().bottom ?? Infinity) <= innerHeight");
		await page.until("!!document.querySelector('.vo-sheet') && document.querySelector('.vo-sheet').getAnimations().every(animation => animation.playState === 'finished')");
	}
	async function close() {
		await page.clickElement("document.querySelector('.vo-sheet button[aria-label=Close]')");
		await page.until("!document.querySelector('.vo-sheet') && document.activeElement?.getAttribute('aria-label') === 'Message to omp'");
	}

	async function updateReplay(replay: CompletionReplay) {
		const snapshot = replay.snapshot();
		await page.evaluate(`window.gate.update(${JSON.stringify(snapshot)})`);
		return snapshot;
	}
	async function inputs(snapshot: TspHostSnapshot): Promise<WireInput[]> {
		return emittedInputs(snapshot, await page.evaluate("window.gate.calls"));
	}
	async function clickOption(id: string, item: string) {
		await page.clickElement(`(() => { const root = [...document.querySelectorAll('[data-tsp-id]')].find(node => node.dataset.tspId === ${JSON.stringify(id)}); return root && [...root.querySelectorAll('[role=option]')].find(option => option.id.endsWith(${JSON.stringify(`-${item}`)})); })()`);
		await page.until(`(() => { const root = [...document.querySelectorAll('[data-tsp-id]')].find(node => node.dataset.tspId === ${JSON.stringify(id)}); return root && [...root.querySelectorAll('[role=option]')].some(option => option.id.endsWith(${JSON.stringify(`-${item}`)}) && option.getAttribute('aria-selected') === 'true'); })()`);
	}
	async function clickAction(snapshot: TspHostSnapshot, event: TspRendererEvent) {
		if (event.ev !== "action") throw new Error("Expected a recorded button action");
		const node = snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]).find(node => node.id === event.id);
		if (!node) throw new Error(`Missing recorded action node ${event.id}`);
		const label = Array.isArray(node.p?.actions) ? node.p.actions.find(action => action.id === event.act)?.label : undefined;
		await page.clickElement(`(() => { const root = [...document.querySelectorAll('[data-tsp-id]')].find(node => node.dataset.tspId === ${JSON.stringify(event.id)}); return root && ${label ? `[...root.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})` : "root.querySelector(':scope > button')"}; })()`);
	}
	it("keeps form ownership through selection request gaps and delayed TSP matching", async () => {
		const entries = askFormEvidence.sessions[0]!.text.trim().split("\n").map(line => JSON.parse(line));
		const call = entries.flatMap(entry => entry.message?.content ?? []).find(part => part.type === "toolCall");
		const stages = askFormEvidence.stages.slice(2, 5);
		const scope = { hostId: "gate", generation: 1, epoch: 1 };
		const surfaces = (stages[0]!.surfaces as unknown as TspSurfaceSnapshot[]).map(surface => ({ ...surface, documentGeneration: 1 }));
		const snapshot = (request: CollabQuestion): TspHostSnapshot => ({ ...recorded("hook-select-open"), ...scope, revision: ++planRevision, surfaces, questionMatches: matchQuestions(scope, { ...scope, connection: 1, revision: 1, connected: true, requests: [request] }, hookQuestions(surfaces, 1)) });
		const first = stages[0]!.request as CollabQuestion;
		await page.evaluate(`window.gate.showAsk(${JSON.stringify(snapshot(first))},${JSON.stringify(first)},${JSON.stringify(call.arguments)})`);
		await page.until(`!!document.querySelector('[data-question-card="${first.reqId}"]') && window.gate.claims().length === 1`);
		await page.evaluate("window.gate.beginFormUpdates()");
		const phases: unknown[] = [];
		for (let index = 0; index < 2; index++) {
			const choice = index === 0 ? "Tests" : "Other (type your own)";
			await page.clickElement(`[...document.querySelectorAll('[data-question-card] [data-choice]')].find(button => button.textContent.trim() === ${JSON.stringify(choice)})`);
			await page.until("window.gate.view().guest.uiRequest === null");
			await page.evaluate("(() => { const {promise,resolve}=Promise.withResolvers(); requestAnimationFrame(()=>requestAnimationFrame(resolve)); return promise; })()");
			expect(await page.evaluate("document.querySelector('[data-form-question]')?.getAttribute('aria-busy')")).toBe("true");
			// Controls keep their normal appearance through the gap; the repeated click below proves the guard instead.
			expect(await page.evaluate("document.querySelector('[data-form-question] fieldset')?.disabled")).toBe(false);
			expect(await page.evaluate("window.gate.claims().length")).toBe(1);
			await page.clickElement(`[...document.querySelectorAll('[data-question-card] [data-choice]')].find(button => button.textContent.trim() === ${JSON.stringify(choice)})`);
			expect(await page.evaluate("window.gate.calls.length")).toBe(index + 1);
			phases.push(await page.evaluate("({phase:'submitted',request:window.gate.view().guest.uiRequest,claims:window.gate.claims(),events:[...window.gate.formPresentationEvents]})"));
			await page.evaluate("window.gate.advanceFormRequest(null)");
			const settling = snapshot(stages[index]!.request as CollabQuestion);
			settling.questionMatches = settling.questionMatches?.map(match => ({ ...match, status: "settling" }));
			await page.evaluate(`window.gate.update(${JSON.stringify(settling)})`);
			const next = stages[index + 1]!.request as CollabQuestion;
			await page.evaluate(`window.gate.advanceFormRequest(${JSON.stringify(next)})`);
			await page.evaluate("(() => { const {promise,resolve}=Promise.withResolvers(); requestAnimationFrame(()=>requestAnimationFrame(resolve)); return promise; })()");
			phases.push(await page.evaluate("({phase:'next-request-before-match',request:window.gate.view().guest.uiRequest.reqId,claims:window.gate.claims(),events:[...window.gate.formPresentationEvents]})"));
			await page.evaluate(`window.gate.update(${JSON.stringify(snapshot(next))})`);
			await page.until(`!!document.querySelector('[data-question-card="${next.reqId}"]') && window.gate.claims().length === 1 && !document.querySelector('.tsp-screen')`);
		}
		const events = await page.evaluate<{ terminalTabId: string | null }[]>("window.gate.formPresentationEvents");
		await writeFile(join(shots, "ask-form-update-trace.json"), JSON.stringify({ watcher: "current", formNodes: hookQuestions(surfaces, 1).map(dialog => dialog.nodeId), phases, events }, null, 2));
		expect(events.filter(event => event.terminalTabId !== null), "a native form stays owned between its collab fields").toEqual([]);
		await page.evaluate("window.gate.showQuestion(false)");
		await page.until("window.gate.claims().length === 0 && !document.querySelector('.tsp-screen')");
		await page.evaluate("window.gate.showQuestion(true)");
		await page.until("window.gate.claims().length === 1 && !document.querySelector('.tsp-screen')");
	}, 30_000);

	it.each([["light", false], ["dark", false], ["light", true], ["dark", true]] as const)("answers the recorded HTML form once in %s (classic=%s)", async (theme, classic) => {
		await page.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
		const entries = askFormEvidence.sessions[0]!.text.trim().split("\n").map(line => JSON.parse(line));
		const calls = entries.flatMap(entry => entry.message?.content ?? []);
		const call = calls.find(part => part.type === "toolCall");
		const result = entries.find(entry => entry.message?.role === "toolResult").message;
		expect(entries.filter(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === call.id)).toHaveLength(1);
		const replies = ["Other (type your own)", "Canary", "Tests", "Other (type your own)", "Accessibility", "Next →", "Reviewed once"];
		let index = 0;
		for (const stage of askFormEvidence.stages) {
			const surfaces = (stage.surfaces as unknown as TspSurfaceSnapshot[]).map(surface => ({ ...surface, documentGeneration: 1 }));
			const scope = { hostId: "gate", generation: 1, epoch: 1 };
			const request = stage.request as CollabQuestion | null;
			const snapshot: TspHostSnapshot = { ...recorded("hook-select-open"), ...scope, revision: ++planRevision, surfaces, questionMatches: matchQuestions(scope, { ...scope, revision: 1, connection: 1, connected: true, requests: request ? [request] : [] }, hookQuestions(surfaces, 1)) };
			await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.dataset.motion='reduced'; window.gate.showAsk(${JSON.stringify(snapshot)},${JSON.stringify(request)},${JSON.stringify(call.arguments)},${request ? "undefined" : JSON.stringify(result)},${classic});`);
			await page.until(request ? `!!document.querySelector('[data-question-card="${request.reqId}"]')` : "!document.querySelector('[data-question-card]') && document.body.textContent.includes('Other: Canary')");
			if (request && !classic) await page.until("window.gate.claims().length === 1");
			expect(await page.evaluate("!!document.querySelector('.tsp-screen')")).toBe(false);
			if (request?.kind === "select") expect(await page.evaluate("document.querySelector('[data-question-card]').textContent")).toContain("Enter");
			if (!classic && index === 0 && request) {
				await page.evaluate("window.gate.showQuestion(false)");
				await page.until("window.gate.claims().length === 0 && !document.querySelector('.tsp-screen')");
				await page.evaluate("window.gate.showQuestion(true)");
				await page.until("!document.querySelector('.tsp-screen') && window.gate.claims().length === 1");
				const uncertain = { ...snapshot, revision: ++planRevision, questionMatches: snapshot.questionMatches?.map(match => ({ ...match, status: "ambiguous" as const, reqId: undefined })) };
				await page.evaluate(`window.gate.update(${JSON.stringify(uncertain)})`);
				await page.until("window.gate.claims().length === 0 && !document.querySelector('.tsp-screen')");
				await page.clickElement("[...document.querySelectorAll('section[aria-label=\"Ask form\"] button')].find(button => button.textContent.trim() === 'View question in omp screen')");
				await page.until("!!document.querySelector('.tsp-screen')");
				await page.clickElement("document.querySelector('.vo-sheet button[aria-label=Close]')");
				await page.until("!document.querySelector('.tsp-screen')");
				await page.evaluate(`window.gate.update(${JSON.stringify({ ...snapshot, revision: ++planRevision })})`);
				await page.until("!document.querySelector('.tsp-screen') && window.gate.claims().length === 1");
			}
			if (index === 0 || !request) {
				await page.evaluate("document.fonts.ready.then(() => true)");
				const screenshot = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
				await writeFile(join(shots, `ask-${classic ? "classic-" : ""}${request ? "pending" : "answered"}-${theme}.png`), Buffer.from(screenshot.data, "base64"));
			}
			if (!request) continue;
			const reply = replies[index++]!;
			if (request.kind === "editor") {
				await page.clickElement("document.querySelector('[data-question-card] textarea')");
				await page.key("a", "KeyA", process.platform === "darwin" ? 4 : 2, ["selectAll"]);
				await page.send("Input.insertText", { text: reply });
				await page.clickElement("[...document.querySelectorAll('[data-question-card] button')].find(button => button.textContent.trim() === 'Send answer')");
			} else if (reply === "Next →") {
				await page.clickElement("[...document.querySelectorAll('[data-question-card] button')].find(button => button.textContent.trim() === 'Send choices')");
			} else {
				await page.clickElement(`[...document.querySelectorAll('[data-question-card] [data-choice]')].find(button => button.textContent.trim() === ${JSON.stringify(reply)})`);
				if (stage.request?.selectionMarker !== "checkbox") await page.clickElement("[...document.querySelectorAll('[data-question-card] button')].find(button => button.textContent.trim() === 'Send answer')");
			}
			expect(await page.evaluate("window.gate.calls")).toEqual([{ channel: "collab:ui-response", args: [request.reqId, reply] }]);
		}
		expect(index).toBe(7);
		await page.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 620, deviceScaleFactor: 1, mobile: false });
	}, 60_000);

	async function paintAsk(): Promise<void> {
		await page.evaluate("(() => { const { promise, resolve } = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(resolve)); return promise; })()");
	}
	async function noAskScreen(): Promise<void> {
		await paintAsk();
		expect(await page.evaluate("!!document.querySelector('.tsp-screen')")).toBe(false);
		expect(await page.evaluate("window.gate.formPresentationEvents.filter(event => event.terminalTabId !== null)")).toEqual([]);
	}
	async function answerForm(request: CollabUiRequest, reply: string): Promise<void> {
		await page.until(`!!document.querySelector('[data-question-card="${request.reqId}"]')`);
		if (request.kind === "editor") {
			await page.clickElement("document.querySelector('[data-question-card] textarea')");
			await page.key("a", "KeyA", process.platform === "darwin" ? 4 : 2, ["selectAll"]);
			await page.send("Input.insertText", { text: reply });
		} else if (reply !== "Next →") {
			await page.clickElement(`[...document.querySelectorAll('[data-question-card] [data-choice]')].find(button => button.textContent.trim() === ${JSON.stringify(reply)})`);
		}
		if (request.kind === "editor" || request.selectionMarker !== "checkbox" || reply === "Next →") {
			await page.clickElement(`[...document.querySelectorAll('[data-question-card] button')].find(button => button.textContent.trim() === ${JSON.stringify(reply === "Next →" ? "Send choices" : "Send answer")})`);
		}
	}
	it.skipIf(process.env.TSP_FORM_LAYOUT_GATE !== "1").each(
		(["reduced", "full"] as const).flatMap(motion => (["short", "overflowing"] as const).flatMap(history => (["idle", "continues", "finishes"] as const).map(reply => ({ motion, history, reply })))),
	)("records form layout at owner dimensions with $motion motion, $history history and $reply reply", async ({ motion, history, reply }) => {
		const baseline = process.env.TSP_FORM_LAYOUT_BASELINE === "1";
		const closeBaseline = process.env.TSP_FORM_CLOSE_BASELINE === "1";
		const directory = process.env.TSP_FORM_LAYOUT_EVIDENCE ?? join(homedir(), "vomp-checks/form-jump", baseline ? "before" : "after");
		await mkdir(directory, { recursive: true });
		await page.send("Emulation.setDeviceMetricsOverride", { width: 1568, height: 1002, deviceScaleFactor: 1, mobile: false });
		const evidence = process.env.TSP_FORM_LAYOUT_RECORDING ? JSON.parse(await readFile(process.env.TSP_FORM_LAYOUT_RECORDING, "utf8")) as AskEvidence : formGuest185 as AskEvidence;
		const engine = evidence.engineVersion ?? "18.18.5";
		const outputName = `${history}-${motion}${reply === "idle" ? "" : `-${reply}`}`;
		const { entries, call, result } = askTranscript(evidence);
		const historyEntries: SessionEntry[] = [];
		if (history === "overflowing") {
			// Public synthetic history exercises the production scroll follower without owner session data.
			for (let index = 0; index < 12; index++) {
				historyEntries.push({ id: `layout-prompt-${index}`, parentId: null, type: "message", timestamp: new Date(index * 2000).toISOString(), message: { role: "user", content: `Review fixture release step ${index + 1}. Keep the release questions available in the chat.`, timestamp: index * 2000 } });
				historyEntries.push({ id: `layout-reply-${index}`, parentId: null, type: "message", timestamp: new Date(index * 2000 + 1000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `Fixture release step ${index + 1} is ready for review.\\n\\nThe form checks release channel, supported platforms, a release note headline and review depth. All answers use the collab request sequence.` }], model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: "stop", timestamp: index * 2000 + 1000 } });
			}
		}
		const requests = evidence.stages.filter(stage => stage.request);
		const replaySnapshot = askSnapshots();
		const snapshot = (stage: AskEvidence["stages"][number], requests = stage.request ? [stage.request] : []) => ({
			...replaySnapshot(stage, requests),
			availability: stage.request ? { available: false, reason: "Answer the question card before sending a message.", reasonCode: "matched-question" as const, questionReqId: stage.request.reqId } : { available: true, reason: null },
		});
		await page.evaluate(`document.documentElement.dataset.motion=${JSON.stringify(motion)}; document.documentElement.dataset.theme='light'; window.gate.showFormLayout(${JSON.stringify(snapshot(requests[0]!))},${JSON.stringify(requests[0]!.request)},${JSON.stringify(call.arguments)},${JSON.stringify([...historyEntries, ...entries])})`);
		await page.until("!!document.querySelector('[data-form-layout] [role=\"log\"]') && !!document.querySelector('[data-gate-composer] textarea') && window.gate.claims().length === 1");
		await page.evaluate("document.fonts.ready.then(() => true)");
		await delay(1200);
		await page.evaluate("window.gate.beginFormUpdates(); window.gate.startLayoutEvidence()");
		const mark = async (phase: string, settle = 200) => {
			await page.evaluate(`window.gate.markLayoutEvidence(${JSON.stringify(phase)})`);
			await delay(settle);
		};
		const choice = (label: string) => `[...document.querySelectorAll('[data-question-card] [data-choice]')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
		const send = () => `[...document.querySelectorAll('[data-question-card] button')].find(button => /^(Send answer|Send choices)$/.test(button.textContent.trim()))`;
		let captured: FormLayoutEvidence;
		let stabilityEnd = 0;
		try {
			await mark("ready");
			for (const [index, stage] of requests.entries()) {
				const request = stage.request!;
				await page.until(`!!document.querySelector('[data-question-card="${request.reqId}"]')`);
				await mark(`request-${request.reqId}-before-click`, 50);
				if (request.kind === "editor") {
					await page.clickElement("document.querySelector('[data-question-card] textarea')", false);
					await page.key("a", "KeyA", process.platform === "darwin" ? 4 : 2, ["selectAll"]);
					await page.send("Input.insertText", { text: "Release fixture headline" });
					await mark(`request-${request.reqId}-text-input`);
					await page.clickElement(send(), false);
				} else if (index === 2) {
					await page.clickElement(send(), false);
				} else {
					await page.clickElement(choice(index === 0 ? "Beta" : index === 1 ? "Linux" : "Full"), false);
					if (request.selectionMarker === "radio") {
						await mark(`request-${request.reqId}-radio-selected`);
						expect(await page.evaluate("window.gate.calls.filter(call => call.channel === 'collab:ui-response').length")).toBe(index);
						await page.key("ArrowUp"); await mark(`request-${request.reqId}-arrow-up`, 80);
						await page.key("ArrowDown"); await mark(`request-${request.reqId}-arrow-down`, 80);
						await page.clickElement(send(), false);
					}
				}
				await page.until("window.gate.view().guest.uiRequest === null");
				await mark(`request-${request.reqId}-retired-gap`);
				await page.clickElement(send(), false);
				await mark(`request-${request.reqId}-disabled-repeat`, 60);
				expect(await page.evaluate("window.gate.calls.filter(call => call.channel === 'collab:ui-response').length")).toBe(index + 1);
				const settling = snapshot(stage, []);
				settling.questionMatches = settling.questionMatches?.map(match => ({ ...match, status: "settling" }));
				await page.evaluate(`window.gate.advanceFormRequest(null); window.gate.update(${JSON.stringify(settling)})`);
				await mark(`request-${request.reqId}-end-before-next`);
				const next = requests[index + 1];
				if (next) {
					await page.evaluate(`window.gate.advanceFormRequest(${JSON.stringify(next.request)})`);
					await mark(`request-${next.request!.reqId}-before-main-match`);
					await page.evaluate(`window.gate.update(${JSON.stringify(snapshot(next))})`);
					await mark(`request-${next.request!.reqId}-matched`, 450);
				}
			}
			stabilityEnd = await page.evaluate<number>("performance.now()");
			await page.evaluate(`window.gate.finishForm(${JSON.stringify(result)},${reply !== "idle"})`);
			await mark("result-before-native-departure");
			expect(await page.evaluate("window.gate.claims().length")).toBe(1);
			await page.evaluate(`window.gate.update(${JSON.stringify(snapshot(evidence.stages.at(-1)!, []))})`);
			await mark("native-departed", reply === "finishes" ? 100 : 450);
			if (reply === "finishes") { await page.evaluate("window.gate.finishWorking()"); await mark("reply-finished", 350); }
			await page.until("window.gate.claims().length === 0 && !document.querySelector('[data-form-question]')");
		} finally {
			captured = await page.evaluate<FormLayoutEvidence>("window.gate.stopLayoutEvidence()");
			const calls = await page.evaluate("window.gate.calls");
			const events = await page.evaluate("window.gate.formPresentationEvents");
			await writeFile(join(directory, `${outputName}.json`), JSON.stringify({ baseline: baseline ? "e88bd9d" : closeBaseline ? "e557710" : null, fixture: `${engine}/ask-fixture-form-guest`, reply, seam: "Production TranscriptBody, usePendingQuestion, WorkingStatus and Composer; recorded requests and native matches; captured collab answer transport", stabilityEnd, ...captured, calls, events }, null, 2));
		}
		const frames = captured.frames.filter(frame => frame.time <= stabilityEnd);
		expect(frames.length).toBeGreaterThan(30);
		expect(captured.viewport).toEqual({ width: 1568, height: 1002 });
		expect(captured.layoutShiftSupported).toBe(true);
		expect(captured.motion).toBe(motion);
		for (const stage of requests) {
			expect(frames.some(frame => frame.phase === `request-${stage.request!.reqId}-retired-gap` && frame.requestId === null && frame.busy === "true"), "every submitted field records its request-retirement gap").toBe(true);
		}
		expect(frames.some(frame => frame.phase === "request-4-before-main-match"), "the text-field transition includes delayed main matching").toBe(true);
		expect(frames.every(frame => frame.card && frame.form && frame.transcript && frame.composer && frame.composerInput)).toBe(true);
		expect(frames.some(frame => frame.transcript!.scrollHeight > frame.transcript!.clientHeight + 1)).toBe(history === "overflowing");
		expect(captured.frames.some(frame => frame.screen), "the form must never auto-open the omp screen").toBe(false);
		expect(await page.evaluate("window.gate.formPresentationEvents.filter(event => event.terminalTabId !== null)"), "even a brief screen open must be reported").toEqual([]);
		expect(frames.every(frame => frame.claims === 1), "native ownership persists through every measured request gap").toBe(true);
		const range = (values: number[]) => Math.max(...values) - Math.min(...values);
		const movement = { cardTop: range(frames.map(frame => frame.card!.top)), composerTop: range(frames.map(frame => frame.composer!.top)), composerInputTop: range(frames.map(frame => frame.composerInput!.top)), scrollTop: range(frames.map(frame => frame.transcript!.scrollTop)), documentScroll: range(frames.map(frame => frame.documentScroll)) };
		const completion = captured.frames.filter(frame => frame.time > stabilityEnd);
		const visibleClosing = completion.filter(frame => frame.card && (frame.cardOpacity ?? 1) > 0.05);
		const previous = frames.at(-1)!;
		const travelExcess = (values: number[]) => values.slice(1).reduce((sum, value, index) => sum + Math.abs(value - values[index]!), 0) - Math.abs(values.at(-1)! - values[0]!);
		const departure = {
			cardDip: Math.max(0, ...visibleClosing.map(frame => frame.card!.top - previous.card!.top)),
			cardDrift: Math.max(0, ...visibleClosing.map(frame => Math.abs(frame.card!.top - previous.card!.top))),
			footerReversal: travelExcess([previous.composer!.top, ...completion.map(frame => frame.composer!.top)]),
			scrollReversal: travelExcess([previous.transcript!.scrollTop, ...completion.map(frame => frame.transcript!.scrollTop)]),
		};
		await writeFile(join(directory, `${outputName}-summary.json`), JSON.stringify({ baseline, closeBaseline, engine, history, motion, reply, frames: frames.length, movement, departure, shifts: captured.shifts }, null, 2));
		if (!baseline) {
			let tallestCard = 0;
			let tallestForm = 0;
			for (const frame of frames) {
				expect(frame.card!.height + 1, `card height must not decrease at ${frame.phase}`).toBeGreaterThanOrEqual(tallestCard);
				expect(frame.form!.height + 1, `form area must not decrease at ${frame.phase}`).toBeGreaterThanOrEqual(tallestForm);
				tallestCard = Math.max(tallestCard, frame.card!.height);
				tallestForm = Math.max(tallestForm, frame.form!.height);
			}
			const radioFrame = frames.find(frame => frame.phase === "request-1-before-click")!;
			const textFrame = frames.find(frame => frame.phase === "request-4-matched")!;
			expect(textFrame.card!.height, "the text question must retain the radio question's height").toBeGreaterThanOrEqual(radioFrame.card!.height - 1);
			expect(movement.cardTop, "question card top must remain stable across all request and focus transitions").toBeLessThanOrEqual(1);
			expect(movement.composerTop, "composer top must remain stable through request retirement").toBeLessThanOrEqual(1);
			expect(movement.composerInputTop, "composer input must not move when a blocked reason changes").toBeLessThanOrEqual(1);
			expect(movement.scrollTop, "answering or focusing must not scroll the transcript").toBeLessThanOrEqual(1);
			expect(movement.documentScroll).toBe(0);
		}
		if (!baseline && !closeBaseline) {
			expect(departure.cardDip, "a completed form must not dip before it leaves").toBeLessThanOrEqual(1);
			expect(departure.cardDrift, "the held form stays fixed until native departure").toBeLessThanOrEqual(1);
			expect(departure.footerReversal, "the footer closes in one direction").toBeLessThanOrEqual(1);
			expect(departure.scrollReversal, "form departure never scrolls away and back").toBeLessThanOrEqual(1);
			const last = completion.at(-1)!;
			expect(Math.abs(last.transcript!.scrollHeight - last.transcript!.clientHeight - last.transcript!.scrollTop)).toBeLessThanOrEqual(1);
		}
		if (baseline) expect(Math.max(movement.cardTop, movement.composerTop, movement.composerInputTop, movement.scrollTop), "the original production modules must reproduce the reported movement").toBeGreaterThan(1);
		expect(await page.evaluate("window.gate.calls")).toEqual(requests.map((stage, index) => ({ channel: "collab:ui-response", args: [stage.request!.reqId, ["Beta", "Linux", "Next →", "Release fixture headline", "Full"][index]] })));
		await page.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 620, deviceScaleFactor: 1, mobile: false });
	}, 60_000);
	it.skipIf(process.env.TSP_FORM_LAYOUT_GATE !== "1").each((["reduced", "full"] as const).flatMap(motion => (["empty", "present"] as const).map(draft => ({ motion, draft }))))("keeps checkbox question text and buttons steady with $motion motion and $draft draft", async ({ motion, draft }) => {
		const directory = join(homedir(), "vomp-checks/toggle-buttons");
		await mkdir(directory, { recursive: true });
		await page.send("Emulation.setDeviceMetricsOverride", { width: 1568, height: 1002, deviceScaleFactor: 1, mobile: false });
		const evidence = formGuest185 as AskEvidence;
		const { entries, call } = askTranscript(evidence);
		const stages = evidence.stages.filter(stage => stage.request?.kind === "select" && stage.request.selectionMarker === "checkbox");
		const firstStage = evidence.stages.find(stage => stage.request)!;
		const snapshot = askSnapshots();
		await page.evaluate(`document.documentElement.dataset.motion=${JSON.stringify(motion)}; window.gate.showFormLayout(${JSON.stringify(snapshot(firstStage))},${JSON.stringify(firstStage.request)},${JSON.stringify(call.arguments)},${JSON.stringify(entries)})`);
		await page.until("window.gate.claims().length === 1 && !!document.querySelector('[data-gate-header] [role=status]')");
		await page.evaluate("window.gate.beginFormUpdates()");
		await answerForm(firstStage.request!, "Beta");
		await page.evaluate(`window.gate.advanceFormRequest(${JSON.stringify(stages[0]!.request)}); window.gate.update(${JSON.stringify(snapshot(stages[0]!))})`);
		await page.until("!!document.querySelector('[data-question-card=\"2\"]') && window.gate.claims().length === 1");
		await page.clickElement("document.querySelector('[data-gate-composer] textarea')", false);
		await page.key("a", "KeyA", process.platform === "darwin" ? 4 : 2, ["selectAll"]);
		await page.key("Backspace");
		if (draft === "present") await page.send("Input.insertText", { text: "Keep this draft while answering." });
		await delay(500);
		await page.evaluate("window.gate.startLayoutEvidence(); window.gate.markLayoutEvidence('before-toggle')");
		await delay(80);
		// Select, then deselect, using the recording's two checked-state shapes with fresh wire ids.
		for (let index = 0; index < 2; index++) {
			await page.clickElement("[...document.querySelectorAll('[data-question-card] [data-choice]')].find(button => button.textContent.trim() === 'Linux')", false);
			await page.until("window.gate.view().guest.uiRequest === null");
			await page.evaluate(`window.gate.markLayoutEvidence('toggle-${index}-retired')`);
			await delay(180);
			await page.evaluate("document.querySelector('[data-question-card] > div:last-child button:last-child').click()");
			expect(await page.evaluate("window.gate.calls.filter(call => call.channel === 'collab:ui-response').length")).toBe(index + 2);
			const source = stages[(index + 1) % 2]!;
			const next = { ...source, request: { ...source.request!, reqId: index + 3 } as CollabUiRequest };
			await page.evaluate(`window.gate.advanceFormRequest(${JSON.stringify(next.request)}); window.gate.markLayoutEvidence('toggle-${index}-before-match')`);
			await delay(100);
			await page.evaluate(`window.gate.update(${JSON.stringify(snapshot(next))}); window.gate.markLayoutEvidence('toggle-${index}-matched')`);
			await delay(180);
		}
		const captured = await page.evaluate<FormLayoutEvidence>("window.gate.stopLayoutEvidence()");
		await writeFile(join(directory, `${draft}-${motion}.json`), JSON.stringify(captured, null, 2));
		expect(captured.viewport).toEqual({ width: 1568, height: 1002 });
		const first = captured.frames[0]!.questionText;
		expect(first.header).toBe("Waiting for your answer");
		expect(first.cardHint).toContain("Sending a message closes this question");
		for (const key of ["header", "placeholder", "composerHint", "cardHint", "working"] as const) {
			const values = [...new Set(captured.frames.map(frame => frame.questionText[key]))];
			expect(values, `${key} remains identical through both toggles`).toEqual([first[key]]);
		}
		const firstButtons = captured.frames[0]!.buttons;
		expect(firstButtons.card.map(button => button.text)).toContain("Skip question");
		expect(firstButtons.card.map(button => button.text)).toContain("Send choices");
		expect(firstButtons.composer.some(button => button.label === "Send message")).toBe(true);
		for (const frame of captured.frames) for (const section of ["card", "composer"] as const) {
			expect(frame.buttons[section].length, `${section} button count at ${frame.phase}`).toBe(firstButtons[section].length);
			for (const [index, button] of frame.buttons[section].entries()) {
				const { box, ...state } = button;
				const { box: firstBox, ...firstState } = firstButtons[section][index]!;
				expect(state, `${section} button ${index} state at ${frame.phase}`).toEqual(firstState);
				for (const key of ["top", "left", "width", "height", "bottom"] as const) expect(Math.abs(box[key] - firstBox[key]), `${section} button ${index} ${key} at ${frame.phase}`).toBeLessThanOrEqual(0.5);
			}
		}
		expect(captured.frames.some(frame => frame.requestId === null)).toBe(true);
		expect(captured.frames.every(frame => frame.claims === 1 && !frame.screen)).toBe(true);
		expect(await page.evaluate("window.gate.calls")).toEqual([{ channel: "collab:ui-response", args: [1, "Beta"] }, { channel: "collab:ui-response", args: [2, "Linux"] }, { channel: "collab:ui-response", args: [3, "Linux"] }]);
		await page.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 620, deviceScaleFactor: 1, mobile: false });
	}, 30_000);
	it.each(askCases185.filter(item => ["ask-fixture-form-guest", "ask-fixture-colors"].includes(item.name)))("answers recorded 18.18.5 $name through collab with native t0 unchanged", async ({ name, evidence }) => {
		const { entries, call, result } = askTranscript(evidence);
		const snapshot = askSnapshots();
		const pending = evidence.stages.filter(stage => stage.request);
		const first = pending[0]!;
		await page.evaluate(`document.documentElement.dataset.motion='reduced'; window.gate.showAsk(${JSON.stringify(snapshot(first))},${JSON.stringify(first.request)},${JSON.stringify(call.arguments)},undefined,false,${JSON.stringify(entries)})`);
		await page.until("window.gate.claims().length === 1");
		await page.evaluate("window.gate.beginFormUpdates()");
		const phases: unknown[] = [];
		const replies = name === "ask-fixture-colors" ? ["#2B72E5 (opaque blue)"] : ["Beta", "Linux", "Next →", "Release fixture headline", "Full"];
		// Color Hide/Show captures retain the same guest request. Each request is answered once.
		const requests = pending.filter((stage, index) => index === 0 || stage.request!.reqId !== pending[index - 1]!.request!.reqId);
		expect(requests).toHaveLength(replies.length);
		for (let index = 0; index < requests.length; index++) {
			const stage = requests[index]!;
			const request = stage.request!;
			await answerForm(request, replies[index]!);
			await page.until("window.gate.view().guest.uiRequest === null");
			await noAskScreen();
			expect(await page.evaluate("document.querySelector('[data-form-question]')?.getAttribute('aria-busy')")).toBe("true");
			expect(await page.evaluate("window.gate.claims().length")).toBe(1);
			phases.push(await page.evaluate(`({phase:'request-gap',requestId:${request.reqId},claims:window.gate.claims()})`));
			await page.evaluate(`window.gate.advanceFormRequest(null); window.gate.update(${JSON.stringify(snapshot(stage, []))})`);
			const next = requests[index + 1];
			if (next) {
				// Collab publishes the next field before main has its new match.
				await page.evaluate(`window.gate.advanceFormRequest(${JSON.stringify(next.request)})`);
				await noAskScreen();
				await page.evaluate(`window.gate.update(${JSON.stringify(snapshot(next))})`);
				await page.until(`!!document.querySelector('[data-question-card="${next.request!.reqId}"]') && window.gate.claims().length === 1`);
			}
		}
		// Delay native departure after the real saved whole-form result arrives.
		await page.evaluate(`window.gate.finishForm(${JSON.stringify(result)})`);
		await noAskScreen();
		await page.until("window.gate.claims().length === 1");
		expect(await page.evaluate("window.gate.view().guest.activeTools.size")).toBe(0);
		expect(await page.evaluate("window.gate.view().guest.entries.filter(entry => entry.message?.role === 'toolResult').length")).toBe(1);
		const expected = requests.map((stage, index) => ({ channel: "collab:ui-response", args: [stage.request!.reqId, replies[index]] }));
		expect(await page.evaluate("window.gate.calls")).toEqual(expected);
		const departure = snapshot(evidence.stages.at(-1)!);
		expect(hookQuestions(departure.surfaces, 1)).toEqual([]);
		await page.evaluate(`window.gate.update(${JSON.stringify(departure)})`);
		await page.until("window.gate.claims().length === 0 && !document.querySelector('[data-form-question]')");
		await noAskScreen();
		await writeFile(join(shots, `${name}-guest-trace.json`), JSON.stringify({ seam: "Production pending selector and cards; recorded collab and native documents; preload answer transport captured", phases, calls: await page.evaluate("window.gate.calls"), result }, null, 2));
	}, 60_000);
	it.each(askCases185)("retains established 18.18.5 $name ownership through recorded native views and result arrival", async ({ name, evidence }) => {
		const { entries, call, result } = askTranscript(evidence);
		if (name === "ask-four-fieldsets-tabs") expect(String(call.arguments.html).match(/<fieldset>/g)).toHaveLength(4);
		const snapshot = askSnapshots();
		const first = evidence.stages[0]!;
		const initial = snapshot(first);
		expect(initial.questionMatches?.[0]?.status).toBe("matched");
		await page.evaluate(`document.documentElement.dataset.motion='reduced'; window.gate.showAsk(${JSON.stringify(initial)},${JSON.stringify(first.request)},${JSON.stringify(call.arguments)},undefined,false,${JSON.stringify(entries)})`);
		await page.until("window.gate.claims().length === 1");
		await page.evaluate("window.gate.beginFormUpdates()");
		const phases: unknown[] = [];
		const views = new Set<string>();
		for (const stage of evidence.stages.filter(stage => stage.request)) {
			const current = snapshot(stage);
			const forms = current.surfaces.flatMap(surface => [...walkNodes(surface.document)]).flatMap(node => {
				const presentation = askFormPresentation(node);
				return presentation ? [{ id: node.id, view: presentation.view, active: presentation.navigation?.active }] : [];
			});
			expect(forms).toHaveLength(1);
			views.add(forms[0]!.view);
			await page.evaluate(`window.gate.advanceFormRequest(${JSON.stringify(stage.request)}); window.gate.update(${JSON.stringify(current)})`);
			await noAskScreen();
			expect(await page.evaluate("window.gate.claims().length"), stage.stage).toBe(1);
			phases.push({ stage: stage.stage, forms, matches: current.questionMatches, claims: await page.evaluate("window.gate.claims()") });
			const capture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(shots, `${name}-${stage.stage}.png`), Buffer.from(capture.data, "base64"));
		}
		expect(views.has("hidden"), name).toBe(name !== "ask-fixture-form-guest");
		if (name.endsWith("-tabs")) expect(views.has("review")).toBe(true);
		const last = evidence.stages.filter(stage => stage.request).at(-1)!;
		await page.evaluate(`window.gate.advanceFormRequest(null); window.gate.update(${JSON.stringify(snapshot(last, []))}); window.gate.finishForm(${JSON.stringify(result)})`);
		await noAskScreen();
		expect(await page.evaluate("window.gate.claims().length")).toBe(1);
		// Also cover result arrival while Review, rather than only the last field tab, remains.
		const review = evidence.stages.find(stage => (stage.surfaces as TspSurfaceSnapshot[]).some(surface => [...walkNodes(surface.document)].some(node => askFormPresentation(node)?.view === "review")));
		if (review) {
			await page.evaluate(`window.gate.update(${JSON.stringify(snapshot(review, []))})`);
			await noAskScreen();
			expect(await page.evaluate("window.gate.claims().length")).toBe(1);
		}
		await page.evaluate(`window.gate.update(${JSON.stringify(snapshot(evidence.stages.at(-1)!, []))})`);
		await page.until("window.gate.claims().length === 0 && !document.querySelector('[data-form-question]')");
		await noAskScreen();
		expect(await page.evaluate("window.gate.calls")).toEqual([]);
		await writeFile(join(shots, `${name}-view-trace.json`), JSON.stringify({ phases, resultBeforeNativeDeparture: true, events: await page.evaluate("window.gate.formPresentationEvents") }, null, 2));
	}, 60_000);
	it.each(["ambiguous", "unsupported"] as const)("keeps an %s form in chat until its explicit omp screen action", async mode => {
		const evidence = formGuest185 as AskEvidence;
		const { entries, call } = askTranscript(evidence);
		const current = askSnapshots()(evidence.stages[0]!);
		if (mode === "ambiguous") current.questionMatches = current.questionMatches?.map(match => ({ ...match, status: "ambiguous", reqId: undefined }));
		else {
			for (const surface of current.surfaces) for (const node of walkNodes(surface.document)) {
				if (node.p?.role === TSP_ROLES.askForm) node.p.role = "fixture.unsupported-form";
			}
			current.questionMatches = [];
		}
		await page.evaluate(`window.gate.showAsk(${JSON.stringify(current)},${JSON.stringify(evidence.stages[0]!.request)},${JSON.stringify(call.arguments)},undefined,false,${JSON.stringify(entries)})`);
		await page.until(`!![...document.querySelectorAll('section[aria-label="Ask form"] button')].find(button => button.textContent.trim() === 'View question in omp screen')`);
		await page.evaluate("window.gate.beginFormUpdates()");
		await noAskScreen();
		expect(await page.evaluate("window.gate.claims().length")).toBe(0);
		const fallback = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(shots, `ask-${mode}-explicit-action.png`), Buffer.from(fallback.data, "base64"));
		await page.clickElement("[...document.querySelectorAll('section[aria-label=\"Ask form\"] button')].find(button => button.textContent.trim() === 'View question in omp screen')");
		await page.until("!!document.querySelector('.tsp-screen')");
		expect(await page.evaluate("window.gate.calls")).toEqual([]);
		await page.clickElement("document.querySelector('.vo-sheet button[aria-label=Close]')");
		await page.until("!document.querySelector('.tsp-screen')");
	}, 30_000);
	it.each(askCases185.filter(item => item.name.endsWith("-tabs") || item.name === "ask-tall-form"))("validates recorded native $name controls through production TspSession only", async ({ name, evidence }) => {
		const directory = join(root, "src/main/omp/tsp/fixtures/18.18.5");
		const messages = (await readFile(join(directory, `${name}.messages.jsonl`), "utf8")).trim().split("\n").map(line => z.object({ verb: z.string(), body: z.unknown() }).parse(JSON.parse(line)));
		const inputs = parseFixtureInputs(await readFile(join(directory, `${name}.events.jsonl`), "utf8"));
		const writes: { verb: string; body: unknown }[] = [];
		const decoder = new TspStream({ onData: () => {}, onMessage: message => writes.push({ verb: message.verb, body: JSON.parse(message.body) }) });
		const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write: data => decoder.push(Buffer.from(data)), onError: error => { throw error; } });
		let cursor = 0;
		const advance = async (boundary: number) => {
			while (cursor < boundary) { const message = messages[cursor++]!; session.receive({ ...message, params: {}, body: JSON.stringify(message.body) }); }
			await session.drain();
		};
		const accepted: TspRendererEvent[] = [];
		for (const input of inputs) {
			if ("keys" in input || (input.body.ev !== "select" && input.body.ev !== "action")) continue;
			await advance(input.afterMessage!);
			const event = input.body;
			const node = session.snapshot().surfaces.flatMap(surface => [...walkNodes(surface.document)]).find(node => node.id === event.id);
			expect(node, `${name} ${JSON.stringify(event)}`).toBeDefined();
			if (event.ev === "select") {
				if (node?.k !== "tabs") throw new Error("Native form navigation must address recorded tabs");
				expect(node.p?.items?.some(item => item.id === event.item)).toBe(true);
			} else if (event.ev === "action") {
				if (node?.k !== "button") throw new Error("Native form action must address a recorded button");
				expect(node.p?.actions?.click).toBe(event.act);
			}
			writes.length = 0;
			await session.send(event);
			expect(writes).toEqual([{ verb: "e", body: event }]);
			accepted.push(event);
		}
		await advance(evidence.stages.at(-1)!.afterMessage);
		expect(session.snapshot().surfaces.flatMap(surface => [...walkNodes(surface.document)]).some(node => askFormPresentation(node))).toBe(false);
		askTranscript(evidence);
		if (name.endsWith("-tabs")) {
			expect(accepted.some(event => event.ev === "select" && event.item === "review")).toBe(true);
			for (const act of ["next", "hide", "submit"]) expect(accepted.some(event => event.ev === "action" && event.act === act)).toBe(true);
		} else {
			expect(accepted.some(event => event.ev === "action" && event.act === "show")).toBe(true);
		}
		await writeFile(join(shots, `${name}-native-session-trace.json`), JSON.stringify({ seam: "Recorded program frames and compatibility inputs only; never the live guest answer path", accepted }, null, 2));
	}, 30_000);

	it("keeps hostile HTML form scripts, media and URLs inert in Chromium", async () => {
		const stage = askFormEvidence.stages.at(-1)!;
		const snapshot: TspHostSnapshot = { ...recorded("hook-select-open"), hostId: "gate", generation: 1, epoch: 1, revision: ++planRevision, questionMatches: [], surfaces: (stage.surfaces as unknown as TspSurfaceSnapshot[]).map(surface => ({ ...surface, documentGeneration: 1 })) };
		const hostile = '<form action="/ask-hostile-proof/submit"><script>window.__askScriptExecuted=true;fetch("/ask-hostile-proof/script")</script><script src="/ask-hostile-proof/script.js"></script><img src="/ask-hostile-proof/image.png" onerror="window.__askScriptExecuted=true" alt="Untrusted image"><svg onload="window.__askScriptExecuted=true"><image href="/ask-hostile-proof/svg.png"></image></svg><iframe src="/ask-hostile-proof/frame"></iframe><video src="/ask-hostile-proof/video" poster="/ask-hostile-proof/poster"></video><link rel="stylesheet" href="/ask-hostile-proof/style"><label>Untrusted question<input name="answer" value="plain text"></label><a href="/ask-hostile-proof/navigation">Untrusted link</a></form>';
		expect(page.requests.some(url => url.includes("gate.html"))).toBe(true);
		await page.evaluate(`window.gate.showAsk(${JSON.stringify(snapshot)},null,${JSON.stringify({ html: hostile })})`);
		await page.until("document.body.textContent.includes('Untrusted question') && document.body.textContent.includes('Untrusted image')");
		await page.evaluate("(() => { const {promise, resolve} = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(resolve)); return promise; })()");
		expect(await page.evaluate("window.__askScriptExecuted === undefined && !document.querySelector('section[aria-label=\"Ask form\"] img, section[aria-label=\"Ask form\"] svg[onload], section[aria-label=\"Ask form\"] iframe, section[aria-label=\"Ask form\"] video, section[aria-label=\"Ask form\"] form')")).toBe(true);
		expect(page.requests.filter(url => url.includes("ask-hostile-proof"))).toEqual([]);
		expect(await page.evaluate("location.pathname")).toContain("gate.html");
	}, 30_000);

	let planRevision = 0;
	it.each(["light", "dark"])("renders the recorded native plan card in %s and activates its approval", async theme => {
		const documents = new FixtureDocuments();
		const recording = loadFixtureRecording("plan-review-execute");
		let cursor = 0;
		for (; cursor < recording.messages.length; cursor++) {
			const message = recording.messages[cursor]!;
			documents.receive({ verb: message.verb, body: JSON.stringify(message.body) });
			if (planReview(documents.snapshot().surfaces)) { cursor++; break; }
		}
		const snapshot = fixtureSnapshot(documents, 1, ++planRevision);
		const review = planReview(snapshot.surfaces)!;
		await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.dataset.motion='reduced'; window.gate.showPlan(${JSON.stringify(snapshot)});`);
		await page.until("!!document.querySelector('section[aria-label=\"Plan ready for review\"]')");
		await page.evaluate("document.fonts.ready.then(() => true)");
		await page.until("document.querySelector('section[aria-label=\"Plan ready for review\"]').getAnimations({subtree:true}).every(animation => animation.playState === 'finished')");
		expect(await page.evaluate("document.body.textContent.includes('Cover the consumer-visible result.')")).toBe(true);
		await page.until(`(() => {
			const section = document.querySelector('section[aria-label="Plan ready for review"]');
			if (!section) return false;
			return ['Approve and run', 'Approve and compact first', 'More options', 'Save and stop'].every(label => {
				const matches = [...section.querySelectorAll('button')].filter(button => button.textContent.trim() === label);
				return matches.length === 1 && window.gate.buttonVisible(matches[0]);
			});
		})()`);
		const clip = await page.evaluate<{ x: number; y: number; width: number; height: number; scale: number }>("(() => { const box = document.querySelector('section[aria-label=\"Plan ready for review\"]').getBoundingClientRect(); return {x:box.x,y:box.y,width:box.width,height:box.height,scale:1}; })()");
		const screenshot = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip });
		await writeFile(join(shots, `plan-card-${theme}.png`), Buffer.from(screenshot.data, "base64"));
		await page.clickElement("[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Approve and run')");
		expect(await inputs(snapshot)).toEqual([{ verb: "e", body: { ev: "activate", sf: review.sf, id: review.optionsId, item: review.options.find(option => option.action === "execute")!.id } }]);
		for (; cursor < recording.messages.length; cursor++) {
			const message = recording.messages[cursor]!;
			if (message.verb === "x") break;
			documents.receive({ verb: message.verb, body: JSON.stringify(message.body) });
			if (!documents.snapshot().surfaces.some(surface => [...walkNodes(surface.document)].some(node => node.id === review.id))) break;
		}
		await page.evaluate(`window.gate.update(${JSON.stringify(fixtureSnapshot(documents, 1, ++planRevision))})`);
		await page.until("!document.querySelector('section[aria-label=\"Plan ready for review\"]')");
	}, 30_000);

	it.each([
		"hotkeys", "jobs", "session", "changelog", "tools", "model-picker", "settings-screen", "exit-with-overlay",
		"extension-rows", "extension-rows-cancel", "extension-rows-open",
		// Native hook completion and screenshots are covered by the card gate below.
		"tree-open", "extensions", "import-claude",
	])("completes recorded %s with real Chrome pointer and keyboard input matching its next accepted events", async name => {
		const replay = new CompletionReplay(name);
		let snapshot = replay.snapshot();
		const expected = replay.expected.map(wireInput);
		try {
			await open(snapshot);
			const first = replay.expected[0]!;
			if (name === "extensions") {
				const select = replay.expected.find(input => !("keys" in input) && input.body.ev === "select");
				if (!select || "keys" in select || select.body.ev !== "select") throw new Error("Missing recorded extensions selection");
				const expand = await page.evaluate("([...document.querySelectorAll('.tsp-screen button')].find(button => button.textContent === 'Expand'))?.disabled");
				expect(expand).toBe(true);
				await clickOption(select.body.id, select.body.item);
				expect(await inputs(snapshot)).toEqual([wireInput(select)]);
				const closeInput = replay.expected.find(input => !("keys" in input) && input.body.ev === "action");
				if (!closeInput || "keys" in closeInput || closeInput.afterMessage === undefined) throw new Error("Missing recorded extensions Close boundary");
				replay.advanceTo(closeInput.afterMessage); snapshot = await updateReplay(replay);
				await clickAction(snapshot, closeInput.body);
			} else if (name === "import-claude") {
				const select = replay.expected[0]!;
				if ("keys" in select || select.body.ev !== "select") throw new Error("Missing startup import selection");
				expect(snapshot.generation).toBe(0);
				expect(await page.evaluate("({ mode: window.gate.view().mode, phase: window.gate.view().host.phase, link: window.gate.view().host.link })")).toEqual({ mode: "starting", phase: "connecting", link: null });
				expect(await page.evaluate("document.querySelector('[role=listbox]').getAttribute('aria-label')")).toBe("Import Claude Session");
				await clickOption(select.body.id, select.body.item);
				expect(await inputs(snapshot)).toEqual([wireInput(select)]);
				await page.key("Enter");
			} else if (name === "tree-open" || (!("keys" in first) && first.body.ev === "activate")) {
				if ("keys" in first || first.body.ev !== "activate") throw new Error("Missing recorded choice activation");
				if (name === "tree-open") {
					const targetId = first.body.id;
					const targetItem = first.body.item;
					const picker = snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]).find(node => node.id === targetId);
					const other = picker?.k === "picker" ? picker.p?.items?.find(item => item.id !== targetItem && !item.disabled) : undefined;
					if (!other) throw new Error("Recorded tree must offer a different row for local selection");
					await clickOption(targetId, other.id);
					expect(await inputs(snapshot), "changing the selected tree row must not navigate").toEqual([]);
				}
				await clickOption(first.body.id, first.body.item);
				expect(await inputs(snapshot), "pointer selection stays local until confirmation").toEqual([]);
				await page.key("Enter");
			} else if (!("keys" in first) && first.body.ev === "edit") {
				const edit = first.body;
				await page.clickElement(`(() => { const root = [...document.querySelectorAll('[data-tsp-id]')].find(node => node.dataset.tspId === ${JSON.stringify(edit.id)}); return root && root.querySelector('input,textarea'); })()`);
				await page.key("a", "KeyA", process.platform === "darwin" ? 4 : 2, ["selectAll"]);
				await page.send("Input.insertText", { text: edit.text });
				await page.until(`document.activeElement.value === ${JSON.stringify(edit.text)}`);
				expect(await inputs(snapshot), "hook typing stays local until submission").toEqual([]);
				if (name.startsWith("hook-input")) await page.key("Enter");
				else await page.key("Enter", "Enter", 2);
			} else if (!("keys" in first) && first.body.ev === "action") {
				if (name === "hook-select-cancel" || name === "hook-editor-cancel") await page.key("Escape");
				else await clickAction(snapshot, first.body);
			} else if ("keys" in first) {
				if (name.startsWith("extension-rows")) await page.clickElement("document.querySelector('.tsp-screen pre')");
				await page.key(first.keys === "\r" ? "Enter" : "Escape");
			} else throw new Error(`No browser input driver for ${name}`);
			expect(await inputs(snapshot)).toEqual(expected);
			const menuIds = new Set([
				...hookQuestions(snapshot.surfaces, snapshot.generation).map(hook => hook.nodeId),
				...snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]).filter(node => ["picker", "prefs", "overlay", "rows"].includes(node.k)).map(node => node.id),
			]);
			replay.finish(); snapshot = await updateReplay(replay);
			expect(openOverlay(snapshot.surfaces)).toBeNull();
			expect(screenSurface(snapshot.surfaces)).toBeNull();
			expect(hookQuestions(snapshot.surfaces, snapshot.generation)).toEqual([]);
			const retainedIds = new Set(snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]).map(node => node.id));
			const removedIds = [...menuIds].filter(id => !retainedIds.has(id));
			if (removedIds.length) await page.until(`![...document.querySelectorAll('.tsp-screen [data-tsp-id]')].some(node => ${JSON.stringify(removedIds)}.includes(node.dataset.tspId))`);
			else {
				expect(snapshot.surfaces.some(surface => surface.closed)).toBe(true);
				await page.until("document.querySelector('.tsp-screen').textContent.includes('This omp screen has closed')");
			}
			await page.until("!!document.querySelector('.tsp-screen') && [...document.querySelectorAll('.tsp-screen button')].every(button => button.disabled)");
		} finally {
			if (await page.evaluate("!!document.querySelector('.vo-sheet')")) await close();
		}
	}, 30_000);

	it("exposes recorded lists and selection in Chrome's accessibility tree and returns focus to the composer", async () => {
		for (const name of ["model-picker", "tree-open"]) {
			await open(await recorded(name));
			const tree = await page.send<AxTree>("Accessibility.getFullAXTree");
			expect(tree.nodes.some(node => node.role?.value === "listbox")).toBe(true);
			expect(tree.nodes.filter(node => node.role?.value === "option").some(node => node.properties?.some(property => property.name === "selected" && property.value.value === true))).toBe(true);
			await page.evaluate("document.querySelector('[role=listbox]').focus()");
			await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End" });
			await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End" });
			await page.until("document.querySelector('[role=listbox]').getAttribute('aria-activedescendant') === [...document.querySelectorAll('[role=option][aria-disabled=false]')].at(-1)?.id");
			await close();
		}
		const hotkeys = await recorded("hotkeys");
		await open(hotkeys);
		const expectedHeads = hotkeys.surfaces.flatMap(surface => [...walkNodes(surface.document)]).filter(node => node.k === "overlay").map(node => plain(node.p?.head) || "omp screen");
		const headings = await page.evaluate<string[]>("[...document.querySelectorAll('[data-tsp-kind=overlay] > [role=dialog]')].map(node => node.getAttribute('aria-label'))");
		expect(headings.length).toBeGreaterThan(0);
		expect(headings).toEqual(expectedHeads);
		const tree = await page.send<AxTree>("Accessibility.getFullAXTree");
		for (const head of expectedHeads) expect(tree.nodes.some(node => node.role?.value === "dialog" && node.name?.value === head)).toBe(true);
		await close();
	}, 60_000);

	it("explains an idle recorded screen without losing its outline or focus target", async () => {
		await open(await recorded("model-picker", true));
		expect(await page.evaluate("document.querySelector('.tsp-screen [role=status]').textContent")).toContain("omp is not showing a menu.");
		expect(await page.evaluate("document.querySelector('.tsp-screen [role=status]').textContent")).toContain("Type a / command");
		expect(await page.evaluate("document.querySelector('.tsp-screen summary').textContent")).toBe("Show raw outline");
		expect(await page.evaluate("document.querySelector('.vo-sheet header').textContent")).not.toContain("Escape dismisses");
		expect(await page.evaluate("document.querySelector('.vo-sheet header').textContent")).toContain("View omp menus and settings for this chat.");
		const capture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(shots, "idle-light-100.png"), Buffer.from(capture.data, "base64"));
		await close();
	});

	it("wraps native button labels and keycaps inside a narrow control at enlarged text", async () => {
		const text = "Close this deliberately long view label " + "unbroken".repeat(24);
		const snapshot = await recorded("hotkeys");
		snapshot.surfaces = snapshot.surfaces.map(surface => ({ ...surface, document: {
			id: surface.open.id, k: "col", c: [{ id: "layer", k: "col", c: [{ id: "long-button", k: "button", p: {
				text, keys: ["ctrl", "shift", "enter"], actions: { click: "close" },
			} }] }],
		} }));
		for (const theme of ["light", "dark"]) {
			await open(snapshot, theme, 130, true);
			try {
				await page.evaluate("document.querySelector('[data-tsp-id=\"long-button\"]').style.width = '180px'");
				const layout = await page.evaluate<{ text: string; fits: boolean; wraps: boolean }>("(() => { const button = document.querySelector('[data-tsp-id=\"long-button\"] button'); return { text: button.textContent, fits: button.scrollWidth <= button.clientWidth + 1, wraps: button.getBoundingClientRect().height > 40 }; })()");
				expect(layout.text).toContain(text);
				expect(layout.fits).toBe(true);
				expect(layout.wraps).toBe(true);
				const capture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
				await writeFile(join(shots, `long-button-${theme}-130.png`), Buffer.from(capture.data, "base64"));
			} finally {
				await close();
			}
		}
	});

	it.each(["hook-select", "hook-confirm", "hook-input", "hook-editor", "hook-select-cancel", "hook-confirm-cancel", "hook-input-cancel", "hook-editor-cancel"])("completes the native %s card in Chrome with the recorded events", async name => {
		const replay = new CompletionReplay(name);
		const snapshot = replay.snapshot();
		await page.evaluate(`window.gate.open(${JSON.stringify(snapshot)})`);
		await page.until("!!document.querySelector('section[aria-label=\"Question from omp\"]')");
		const first = replay.expected[0]!;
		if ("keys" in first) throw new Error("Expected semantic hook answer");
		if (name.endsWith("cancel")) {
			if (name === "hook-confirm-cancel") {
				await page.evaluate("document.querySelector('section[aria-label=\"Question from omp\"] button').focus()");
				await page.key("Escape");
			} else await page.clickElement("[...document.querySelectorAll('section button')].find(button => button.textContent === 'Cancel')");
		} else if (first.body.ev === "activate") {
			if (name === "hook-confirm") await page.clickElement("[...document.querySelectorAll('section button')].find(button => button.textContent === 'Yes')");
			else {
				const { item, id } = first.body;
				const picker = snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]).find(node => node.k === "picker" && node.id === id);
				const index = picker?.k === "picker" ? picker.p?.items?.findIndex(option => option.id === item) : -1;
				await page.clickElement(`document.querySelectorAll('section [role=radio]')[${index}]`);
				expect(await inputs(snapshot)).toEqual([]);
				await page.clickElement("[...document.querySelectorAll('section button')].find(button => button.textContent === 'Choose option')");
			}
		} else if (first.body.ev === "edit") {
			await page.clickElement("document.querySelector('section input, section textarea')");
			await page.key("a", "KeyA", process.platform === "darwin" ? 4 : 2, ["selectAll"]);
			await page.send("Input.insertText", { text: first.body.text });
			expect(await inputs(snapshot)).toEqual([]);
			await page.clickElement("[...document.querySelectorAll('section button')].find(button => button.textContent === 'Send answer')");
		}
		expect(await inputs(snapshot)).toEqual(replay.expected.map(wireInput));
		expect(await page.evaluate("[...document.querySelectorAll('section button')].every(button => button.disabled)")).toBe(true);
		replay.finish(); await updateReplay(replay);
		await page.until("!document.querySelector('section[aria-label=\"Question from omp\"]')");
	});

	it.each(["light", "dark"])("captures the TSP native hook card in %s at normal and enlarged text", async theme => {
		for (const scale of [100, 130]) {
			const snapshot = recorded("hook-select");
			await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.dataset.motion='reduced'; document.documentElement.style.fontSize=${JSON.stringify(`${scale}%`)}; window.gate.open(${JSON.stringify(snapshot)});`);
			await page.until("document.querySelectorAll('section [role=radio]').length === 4");
			await page.evaluate("document.fonts.ready.then(() => true)");
			expect(await page.evaluate("document.body.scrollWidth <= innerWidth")).toBe(true);
			expect(await page.evaluate("[...document.querySelectorAll('section [role=radio]')].every(option => option.scrollWidth <= option.clientWidth + 1)")).toBe(true);
			const capture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(shots, `native-hook-card-${theme}-${scale}.png`), Buffer.from(capture.data, "base64"));
		}
	});

	it.each(["light", "dark"])("fits recorded menus at minimum size with normal and enlarged text in %s, including reduced motion", async theme => {
		for (const scale of [100, 130]) for (const name of ["model-picker", "settings-screen", "jobs", "usage", "session", "hotkeys", "changelog", "tools", "tree-open"]) {
			const snapshot = await recorded(name);
			await open(snapshot, theme, scale, scale === 130);
			const overflow = await page.evaluate("({ body: document.body.scrollWidth > innerWidth, screen: document.querySelector('.tsp-screen').scrollWidth > document.querySelector('.tsp-screen').clientWidth + 1 })");
			expect(overflow, `${name} ${theme} ${scale}`).toEqual({ body: false, screen: false });
			expect(await page.evaluate("[...document.querySelectorAll('.vo-sheet header button')].every(button => { const b = button.getBoundingClientRect(); const s = document.querySelector('.vo-sheet').getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.left >= s.left && b.right <= s.right && b.top >= s.top && b.bottom <= s.bottom; })")).toBe(true);
			expect(await page.evaluate("[...document.querySelectorAll('[data-tsp-kind=picker] .sticky')].every(row => getComputedStyle(row).flexWrap === 'wrap')")).toBe(true);
			if (name === "changelog") {
				expect(await page.evaluate("(() => { const screen = document.querySelector('.tsp-screen'); screen.scrollTop = screen.scrollHeight; return screen.scrollTop > 0 && document.body.scrollTop === 0 && screen.scrollHeight > screen.clientHeight; })()")).toBe(true);
			}
			const expectedActions = [...new Set(snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]).flatMap(node => node.k === "picker" ? node.p?.actions?.map(action => action.label) ?? [] : []))];
			const labels = await page.evaluate<string[]>("[...document.querySelectorAll('.tsp-screen button')].map(button => button.textContent.trim())");
			for (const label of expectedActions) expect(labels, `${name} expected action ${label}`).toContain(label);
			if (["model-picker", "hook-select", "tree-open"].includes(name)) expect(expectedActions.length).toBeGreaterThan(0);
			const buttons = await page.evaluate<number>("document.querySelector('.tsp-screen').querySelectorAll('button').length");
			for (let index = 0; index < buttons; index++) {
				const visible = await page.evaluate(`window.gate.buttonVisible(document.querySelector('.tsp-screen').querySelectorAll('button')[${index}])`);
				expect(visible, `${name} action ${index} ${theme} ${scale}`).toBe(true);
			}
			await page.evaluate("document.querySelector('.tsp-screen').scrollTop=0");
			if (name === "hook-select") {
				const long = await page.evaluate<{ text: string; title: string; wraps: boolean }>("(() => { const option = [...document.querySelectorAll('[role=option]')].find(node => node.textContent.includes('A long fixture option')); return { text: option.textContent, title: option.title, wraps: option.scrollWidth <= option.clientWidth + 1 }; })()");
				expect(long.text).toContain("text size is increased"); expect(long.wraps || long.title.includes("text size is increased")).toBe(true);
			}
			const capture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(shots, `${name}-${theme}-${scale}.png`), Buffer.from(capture.data, "base64"));
			await close();
		}
	}, 120_000);
});
