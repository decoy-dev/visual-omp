// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import type { TspHookAnswer } from "@shared/tsp/dialogs";
import { hookDialogTarget } from "@shared/tsp/dialogs";
import { composer, walkNodes } from "@shared/tsp/view-state";
import { composerFacts } from "../../../../main/omp/tsp/composer";
import { FixtureDocuments, loadFixtureRecording, type FixtureInput } from "../tsp/testing/documents";
import type { SessionController } from "../../state/session";
import { screenActivity } from "../../state/tsp/screen-activity";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { navigateTo } from "./navigate";
import "../../i18n";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Set<(patch: TspHostPatch) => void>() }));
vi.mock("../../state/app", () => ({ useApp: {} }));
vi.mock("@/ui", () => ({ toast: vi.fn() }));
const draft = "  Add a branch for the alternate fixture answer.\nKeep café 🧭 spacing.  \n";
const seed = [
	{ id: "00000002", parentId: null, type: "message", message: { role: "assistant", content: "Shared answer" } },
	{ id: "00000003", parentId: "00000002", type: "message", message: { role: "user", content: draft } },
].map(entry => JSON.stringify(entry)).join("\n");

class Replay {
	readonly recording;
	readonly docs = new FixtureDocuments();
	readonly listeners = new Set<() => void>();
	readonly events: TspRendererEvent[] = [];
	guest = {};
	readonly setLeaf = vi.fn();
	readonly answer = vi.fn((_reqId: number, value: string) => {
		expect(value).toBe("No summary");
		const question = hookDialogTarget(this.snapshot().surfaces)!;
		if (question.dialog.body.kind !== "select") throw new Error("Expected summary selector");
		this.consume({ ev: "activate", sf: question.surface.open.id, id: question.dialog.body.target, item: question.dialog.body.options.find(option => option.label === value)!.id });
	});
	index = 0; message = 0; revision = 0; generation = 1; epoch = 1;
	readOnly = false;
	match: "unmatched" | "matched" | "ambiguous" = "unmatched";
	mutate: ((snapshot: TspHostSnapshot) => void) | null = null;
	holdActivation = false;
	constructor(name: string) {
		this.recording = loadFixtureRecording(name);
		// DA1 replies are transport housekeeping. Every application input must be semantic.
		expect(this.recording.inputs.filter(input => "keys" in input).every(input => "keys" in input && input.keys === "\x1b[?62;22c")).toBe(true);
		this.recording.inputs = this.recording.inputs.filter(input => "verb" in input);
		this.advance();
		bridge.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
			if (channel === "sessions:read") return seed;
			if (channel === "host:tsp-snapshot") return this.snapshot();
			if (channel === "host:tsp-tree-activate") {
				const [host, generation, epoch, sf, id, entryId] = args;
				expect([host, generation, epoch]).toEqual(["host", 1, 1]);
				this.consume({ ev: "activate", sf: sf as string, id: id as string, item: entryId as string });
				return;
			}
			if (channel === "host:tsp-answer") {
				const answer = args[2] as TspHookAnswer;
				expect(answer.kind).toBe("choose");
				if (answer.kind === "choose") this.consume({ ev: "activate", sf: answer.sf, id: answer.target, item: answer.item });
				return;
			}
			if (channel === "host:take-editor-restore") {
				const [host, generation, epoch, sf, id, text] = args;
				expect([host, generation, epoch]).toEqual(["host", 1, 1]);
				expect(text).toBe(draft);
				useComposerDrafts.getState().restoreEditor("chat", "tree-restore", text as string);
				this.consume({ ev: "edit", sf: sf as string, id: id as string, from: 0, to: (text as string).length, text: "", cursor: 0, len: (text as string).length });
				return;
			}
			if (channel === "host:tsp-event") { this.consume(args[2] as TspRendererEvent); return; }
			throw new Error(`Forbidden or unexpected tree IPC: ${channel}`);
		});
	}
	advance() {
		const boundary = this.recording.inputs[this.index]?.afterMessage ?? this.recording.messages.length;
		while (this.message < boundary) {
			const message = this.recording.messages[this.message++]!;
			this.docs.receive({ verb: message.verb, body: JSON.stringify(message.body) });
		}
		this.publish();
	}
	snapshot(): TspHostSnapshot {
		const document = structuredClone(this.docs.snapshot());
		const facts = composerFacts(document.surfaces);
		const snapshot: TspHostSnapshot = { ...document, epoch: this.epoch, hostId: "host", generation: this.generation, revision: ++this.revision,
			lifecycle: "live", documentGeneration: this.generation, failure: null, composer: facts,
			availability: { available: facts.sendable && !facts.blockedBy, reason: facts.blockedBy ? "Close omp's menu." : null },
			surfaces: document.surfaces.map(surface => ({ ...surface, documentGeneration: this.generation })) };
		const question = hookDialogTarget(snapshot.surfaces);
		snapshot.questionMatches = question ? [{ surfaceId: question.surface.open.id, nodeId: question.node.id, status: this.match, ...(this.match === "matched" ? { reqId: 7 } : {}) }] : [];
		this.mutate?.(snapshot);
		return snapshot;
	}
	publish() {
		const snapshot = this.snapshot();
		for (const listener of bridge.listeners) listener(tspHostPatch(null, snapshot));
		for (const listener of this.listeners) listener();
	}
	consume(event: TspRendererEvent) {
		if (event.ev !== "send" || event.text !== "/exit") expect(screenActivity.has(this.snapshot(), "drive")).toBe(true);
		const input = this.recording.inputs[this.index]!;
		expect(event).toEqual((input as Extract<FixtureInput, { verb: "e" }>).body);
		this.events.push(event); this.index++;
		if (!this.holdActivation || event.ev !== "activate") this.advance();
	}
	readonly session = {
		hostId: "host", tabId: "chat", projectPath: "/tmp", sessionFile: "/tmp/tree-session.jsonl",
		whenLive: async () => {}, guestClient: () => this.guest,
		getSnapshot: () => ({ mode: "live", working: false, readOnly: this.readOnly, displayLeaf: null,
			host: { hostId: "host", generation: this.generation, sessionId: "session", phase: "live", transport: "tsp" } }),
		subscribe: (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); },
		command: async (text: string) => { const target = composer(this.docs.snapshot().surfaces)!; this.consume({ ev: "send", sf: target.surface.open.id, id: target.node.id, text }); },
		setDisplayLeaf: this.setLeaf, answer: this.answer,
	} as unknown as SessionController;
}

/** Add the documented All-tab exchange ahead of the recorded activation. */
function filteredReplay(replacement: "selector" | "surface" | null = null): Replay {
	const replay = new Replay("tree-navigate");
	const activation = replay.recording.inputs[1]!;
	if (!("verb" in activation) || activation.body.ev !== "activate") throw new Error("Expected recorded tree activation");
	replay.recording.inputs.splice(1, 0, { verb: "e", afterMessage: activation.afterMessage, body: {
		ev: "action", sf: activation.body.sf, id: activation.body.id, act: "tab", value: "all",
	} });
	let filtered = false;
	replay.mutate = snapshot => {
		for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) {
			if (node.k !== "picker" || node.p?.layout !== "tree") continue;
			if (!filtered) node.p.order = node.p.order?.filter(id => id !== "00000003");
			else if (replacement === "selector") node.id = "replacement-selector";
			else if (replacement === "surface") surface.open = { ...surface.open, id: "replacement-surface" };
		}
	};
	const invoke = bridge.invoke.getMockImplementation()!;
	bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
		const event = args[2] as TspRendererEvent | undefined;
		if (channel === "host:tsp-event" && event?.ev === "action" && event.act === "tab") filtered = true;
		return invoke(channel, ...args);
	});
	return replay;
}

beforeEach(() => {
	vi.useFakeTimers(); bridge.invoke.mockReset(); bridge.listeners.clear();
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke: (...args: unknown[]) => bridge.invoke(...args), on: (channel: string, listener: (patch: TspHostPatch) => void) => {
		if (channel === "host:tsp-patch") bridge.listeners.add(listener);
		return () => bridge.listeners.delete(listener);
	} } });
	localStorage.clear(); useComposerDrafts.setState({ drafts: {}, previews: {}, editorRestores: {}, pendingFocus: {} });
});
afterEach(async () => {
	await Promise.resolve();
	expect(screenActivity.has({ hostId: "host", generation: 1, epoch: 1 }, "drive")).toBe(false);
	vi.useRealTimers();
});

describe("TSP tree navigation", () => {
	it.each(["tree-navigate", "tree-navigate-summary"])("completes %s with one exact tree activation and recoverable exact draft transfer", async name => {
		const replay = new Replay(name);
		useComposerDrafts.getState().setDraft("chat", "Newer app draft");
		await expect(navigateTo(replay.session, "00000003")).resolves.toEqual({ draft });
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
		expect(replay.events.filter(event => event.ev === "activate" && event.item === "00000003")).toHaveLength(1);
		expect(replay.events.some(event => event.ev === "select")).toBe(false);
		expect(replay.snapshot().composer?.text).toBe("");
		expect(useComposerDrafts.getState().drafts.chat).toBe(`Newer app draft\n${draft}`);
		expect(replay.setLeaf).toHaveBeenCalledExactlyOnceWith("00000002");
		await replay.session.command("/exit");
		expect(replay.index).toBe(replay.recording.inputs.length);
		expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
	});
	it("holds the unclaimed tree picker beyond the automatic screen settle interval", async () => {
		const replay = new Replay("tree-navigate"); replay.holdActivation = true;
		const navigation = navigateTo(replay.session, "00000003");
		await vi.advanceTimersByTimeAsync(500);
		expect(replay.events.map(event => event.ev)).toEqual(["send", "activate"]);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(true);
		replay.holdActivation = false; replay.advance();
		await expect(navigation).resolves.toEqual({ draft });
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
	});
	it("answers a replicated summary question only through collab", async () => {
		const replay = new Replay("tree-navigate-summary"); replay.match = "matched";
		await expect(navigateTo(replay.session, "00000003")).resolves.toEqual({ draft });
		expect(replay.answer).toHaveBeenCalledExactlyOnceWith(7, "No summary");
		expect(bridge.invoke.mock.calls.some(([channel]) => channel === "host:tsp-answer")).toBe(false);
	});
	it("does not answer an ambiguous summary question or clear its draft", async () => {
		const replay = new Replay("tree-navigate-summary"); replay.match = "ambiguous";
		const navigation = navigateTo(replay.session, "00000003");
		const rejected = expect(navigation).rejects.toThrow("unavailable or ambiguous");
		await vi.advanceTimersByTimeAsync(8001); await rejected;
		expect(replay.events.map(event => event.ev)).toEqual(["send", "activate"]);
		expect(replay.answer).not.toHaveBeenCalled();
	});
	it("refuses a disabled entry without activation", async () => {
		const replay = new Replay("tree-navigate");
		replay.mutate = snapshot => { for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) {
			if (node.k === "picker" && node.p?.layout === "tree") node.p.items = node.p.items?.map(item => item.id === "00000003" ? { ...item, disabled: "This recorded entry is disabled." } : item);
		} };
		await expect(navigateTo(replay.session, "00000003")).rejects.toThrow("This recorded entry is disabled.");
		expect(replay.events.map(event => event.ev)).toEqual(["send"]);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
	});
	it("changes the original selector's filter before exactly one recorded entry activation", async () => {
		const replay = filteredReplay();
		await expect(navigateTo(replay.session, "00000003")).resolves.toEqual({ draft });
		expect(replay.events.map(event => event.ev)).toEqual(["send", "action", "activate", "edit"]);
		expect(replay.events[1]).toMatchObject({ ev: "action", id: "n.^picker", act: "tab", value: "all" });
		expect(replay.events.filter(event => event.ev === "activate")).toEqual([{ ev: "activate", sf: "s:1", id: "n.^picker", item: "00000003" }]);
		expect(replay.setLeaf).toHaveBeenCalledExactlyOnceWith("00000002");
	});
	it.each(["selector", "surface"] as const)("refuses a replacement %s during the All-filter wait without activating it", async replacement => {
		const replay = filteredReplay(replacement);
		await expect(navigateTo(replay.session, "00000003")).rejects.toThrow("selector changed while changing its filter");
		expect(replay.events.map(event => event.ev)).toEqual(["send", "action"]);
		expect(bridge.invoke.mock.calls.some(([channel]) => channel === "host:tsp-tree-activate" || channel === "host:take-editor-restore" || channel === "host:tsp-answer")).toBe(false);
		expect(replay.setLeaf).not.toHaveBeenCalled();
		expect(replay.answer).not.toHaveBeenCalled();
		expect(bridge.listeners.size).toBe(0);
	});
	it.each(["generation", "epoch"] as const)("cancels navigation after a %s change without draft transfer", async change => {
		const replay = new Replay("tree-navigate"); replay.holdActivation = true;
		const navigation = navigateTo(replay.session, "00000003");
		const scope = replay.snapshot();
		const rejected = expect(navigation).rejects.toThrow("chat changed");
		await vi.advanceTimersByTimeAsync(500);
		expect(screenActivity.has(scope, "drive")).toBe(true);
		if (change === "generation") replay.generation++; else replay.epoch++;
		replay.publish(); await rejected;
		expect(screenActivity.has(scope, "drive")).toBe(false);
		expect(replay.setLeaf).not.toHaveBeenCalled();
		expect(useComposerDrafts.getState().drafts.chat).toBeUndefined();
		expect(bridge.listeners.size).toBe(0);
	});
	describe.each(["command", "activation", "restore"] as const)("pending navigation %s", stage => {
		it.each(["generation", "epoch", "guest", "lifecycle", "readOnly", "closing"] as const)("releases its drive immediately on %s invalidation", async change => {
			const replay = new Replay("tree-navigate");
			const pending = Promise.withResolvers<void>();
			if (stage === "command") vi.spyOn(replay.session, "command").mockImplementation(() => pending.promise);
			else {
				const invoke = bridge.invoke.getMockImplementation()!;
				const channelToHold = stage === "activation" ? "host:tsp-tree-activate" : "host:take-editor-restore";
				bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === channelToHold ? pending.promise : invoke(channel, ...args));
			}
			const scope = replay.snapshot();
			let finished = false;
			const navigation = navigateTo(replay.session, "00000003").then(
				() => { finished = true; return null; },
				error => { finished = true; return error; },
			);
			await vi.advanceTimersByTimeAsync(10);
			expect(screenActivity.has(scope, "drive")).toBe(true);
			if (stage === "command") expect(replay.session.command).toHaveBeenCalledWith("/tree");
			else expect(bridge.invoke.mock.calls.some(([channel]) => channel === (stage === "activation" ? "host:tsp-tree-activate" : "host:take-editor-restore"))).toBe(true);
			if (change === "generation") replay.generation++;
			else if (change === "epoch") replay.epoch++;
			else if (change === "guest") replay.guest = {};
			else if (change === "readOnly") replay.readOnly = true;
			else replay.mutate = snapshot => {
				if (change === "lifecycle") snapshot.lifecycle = "transitioning";
				else snapshot.closing = true;
			};
			replay.publish();
			expect(finished).toBe(false);
			expect(screenActivity.has(scope, "drive")).toBe(false);
			pending.reject(new Error("Pending native write refused"));
			expect(await navigation).toBeInstanceOf(Error);
			expect(replay.events.map(event => event.ev)).toEqual(stage === "command" ? [] : stage === "activation" ? ["send"] : ["send", "activate"]);
			expect(useComposerDrafts.getState().drafts.chat).toBeUndefined();
			expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
		});
	});
});
