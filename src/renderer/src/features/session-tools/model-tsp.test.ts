// @vitest-environment happy-dom
import type { ModelInfo } from "@shared/contracts/config";
import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import { composer, openOverlay, walkNodes } from "@shared/tsp/view-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { FixtureDocuments, loadFixtureRecording, type FixtureInput } from "../tsp/testing/documents";
import type { SessionController } from "../../state/session";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { switchModel, setThinking } from "./model";
import { semanticThinking } from "./modelTsp";
import { ModelList, ThinkingButton } from "./pickers";
import { TooltipProvider } from "../../ui/Tooltip";
import "../../i18n";

const bridge = vi.hoisted(() => {
	const state = { invoke: vi.fn(), listeners: new Set<(snapshot: TspHostSnapshot) => void>(), toast: vi.fn() };
	Object.defineProperty(window, "vomp", { configurable: true, value: {
		on: (channel: string, listener: (snapshot: TspHostSnapshot) => void) => {
			if (channel === "host:tsp-update") state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},
		invoke: (...args: unknown[]) => state.invoke(...args),
	} });
	return state;
});
vi.mock("@/ui", async () => ({ ...await vi.importActual<object>("@/ui"), toast: bridge.toast }));

const small: ModelInfo = { selector: "fixture/fixture-small", provider: "fixture", id: "fixture-small", name: "Fixture small", kind: "chat", contextWindow: 32000, maxOutputTokens: 4096, reasoning: true, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh"], vision: false, cost: null };
const large: ModelInfo = { ...small, selector: "fixture/fixture-large", id: "fixture-large", name: "Fixture large", contextWindow: 128000 };

class Replay {
	readonly recording;
	readonly docs = new FixtureDocuments();
	readonly listeners = new Set<() => void>();
	readonly events: TspRendererEvent[] = [];
	readonly guest = {};
	index = 0;
	message = 0;
	revision = 0;
	model = large;
	requests: CollabUiRequest[] = [];
	generation = 1;
	autoConfirm = true;
	confirmDelay = 0;
	responseDelay = 0;
	mutate: ((snapshot: TspHostSnapshot) => void) | null = null;
	beforeEvent: ((event: TspRendererEvent) => void) | null = null;
	view = this.readView();
	readView() {
		return { mode: "live", readOnly: false, host: { hostId: "host", generation: this.generation, sessionId: "session", transport: "tsp" }, guest: { phase: "live", entries: [], pendingUiRequests: this.requests, uiRequest: this.requests[0] ?? null, state: { model: this.model, contextUsage: { tokens: 0 } } } };
	}
	constructor(name: string) {
		this.recording = loadFixtureRecording(name);
		this.advance();
		bridge.invoke.mockImplementation(async (channel: string, _host: string, generation: number, event: TspRendererEvent, epoch: number) => {
			if (channel === "host:tsp-snapshot") return this.snapshot();
			if (channel === "host:tsp-event") {
				expect(generation).toBe(1); expect(epoch).toBe(1);
				this.beforeEvent?.(event);
				this.consume(event);
			}
			if (channel === "config:models") return [large, small];
			if (channel === "host:screen" || channel === "host:keys") throw new Error("Painted-screen input is forbidden in TSP model controls");
			return null;
		});
	}
	advance(): void {
		const boundary = this.recording.inputs[this.index]?.afterMessage ?? this.recording.messages.length;
		while (this.message < boundary) {
			const message = this.recording.messages[this.message++]!;
			this.docs.receive({ verb: message.verb, body: JSON.stringify(message.body) });
		}
		this.publish();
	}
	snapshot(): TspHostSnapshot {
		const document = this.docs.snapshot();
		const available = !!composer(document.surfaces) && !openOverlay(document.surfaces);
		const snapshot: TspHostSnapshot = { ...document, hostId: "host", generation: 1, revision: ++this.revision, lifecycle: "live", documentGeneration: 1, failure: null,
			availability: { available, reason: available ? null : "Close omp's menu first." }, surfaces: document.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
		this.mutate?.(snapshot);
		return snapshot;
	}
	publish(): void {
		this.view = this.readView();
		const snapshot = this.snapshot();
		for (const listener of bridge.listeners) listener(snapshot);
		for (const listener of this.listeners) listener();
	}
	consume(event: TspRendererEvent): void {
		const input = this.recording.inputs[this.index]!;
		expect(input).toHaveProperty("verb", "e");
		expect(event).toEqual((input as Extract<FixtureInput, { verb: "e" }>).body);
		this.events.push(event); this.index++;
		if (event.ev === "activate" && this.responseDelay > 0) {
			const message = this.recording.messages[this.message++]!;
			this.docs.receive({ verb: message.verb, body: JSON.stringify(message.body) });
			this.publish();
			setTimeout(() => this.advance(), this.responseDelay);
		} else this.advance();
		if (event.ev === "activate" || (event.ev === "send" && event.text.startsWith("/switch"))) {
			if (this.autoConfirm) setTimeout(() => { this.model = small; this.publish(); }, this.confirmDelay);
		}
	}
	readonly session = {
		hostId: "host", tabId: "chat", projectPath: "/tmp",
		whenLive: async () => {}, guestClient: () => this.guest,
		getSnapshot: () => this.view,
		subscribe: (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); },
		command: async (text: string) => {
			const target = composer(this.docs.snapshot().surfaces)!;
			this.consume({ ev: "send", sf: target.surface.open.id, id: target.node.id, text });
		},
	} as unknown as SessionController;
}

beforeEach(() => {
	vi.useFakeTimers(); bridge.listeners.clear(); bridge.invoke.mockReset(); bridge.toast.mockClear();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { vi.useRealTimers(); });

async function settle<T>(promise: Promise<T>, milliseconds = 10000): Promise<T> {
	await vi.advanceTimersByTimeAsync(milliseconds);
	return promise;
}

describe("TSP composer model controls", () => {
	it("replays the exact session picker activation and waits for collab identity", async () => {
		const replay = new Replay("model-switch"); replay.confirmDelay = 1500;
		let finished = false;
		const switching = switchModel(replay.session, small).then(result => { finished = true; return result; });
		await vi.advanceTimersByTimeAsync(500);
		expect(replay.events.map(event => event.ev)).toEqual(["action", "activate"]);
		expect(finished).toBe(false);
		await expect(settle(switching)).resolves.toBe(true);
		expect(bridge.toast).not.toHaveBeenCalled();
		expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
	});

	it("does not report success from a closed picker alone", async () => {
		const replay = new Replay("model-switch"); replay.autoConfirm = false;
		await expect(settle(switchModel(replay.session, small))).resolves.toBe(false);
		expect(bridge.toast).toHaveBeenCalledWith({ tone: "warn", message: expect.stringContaining("Open the omp screen") });
	});

	it("does not report success from collab identity while the picker remains open", async () => {
		const replay = new Replay("model-switch");
		replay.beforeEvent = event => { if (event.ev === "activate") {
			replay.advance = () => { replay.model = small; replay.publish(); };
		} };
		await expect(settle(switchModel(replay.session, small))).resolves.toBe(false);
	});

	it("replays documented typed switching when the model action is unavailable", async () => {
		const replay = new Replay("switch-typed");
		replay.mutate = snapshot => {
			for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) if (node.p?.role === "omp.composer.model") node.p.actions = undefined;
		};
		await expect(settle(switchModel(replay.session, small))).resolves.toBe(true);
		expect(replay.events).toHaveLength(1);
		expect(replay.events[0]).toMatchObject({ ev: "send", text: "/switch fixture/fixture-small" });
	});

	it("closes a picker without the exact item before using typed fallback and never activates a similar name", async () => {
		const replay = new Replay("model-switch");
		replay.mutate = snapshot => {
			for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) {
				if (node.k === "picker") node.p = { ...node.p, items: node.p?.items?.map(item => item.id === small.selector ? { ...item, id: `${small.selector}-similar`, label: small.name } : item) };
			}
		};
		const activation = replay.recording.inputs[1]!;
		if (!("verb" in activation)) throw new Error("Expected semantic activation fixture input");
		activation.body = { ev: "action", sf: "s:1", id: "j", act: "close" };
		replay.recording.inputs.splice(2, 0, { verb: "e", body: { ev: "send", sf: "s:1", id: "g.line/input", text: `/switch ${small.selector}` }, afterMessage: replay.recording.inputs[2]!.afterMessage });
		await expect(settle(switchModel(replay.session, small))).resolves.toBe(true);
		expect(replay.events).toEqual([
			{ ev: "action", sf: "s:1", id: "g.bar/model", act: "status.model" },
			{ ev: "action", sf: "s:1", id: "j", act: "close" },
			{ ev: "send", sf: "s:1", id: "g.line/input", text: `/switch ${small.selector}` },
		]);
	});

	it("refuses a disabled exact model without activation or typed fallback", async () => {
		const replay = new Replay("model-switch");
		replay.mutate = snapshot => {
			for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) {
				if (node.k === "picker") node.p = { ...node.p, items: node.p?.items?.map(item => item.id === small.selector ? { ...item, disabled: "Fixture model disabled" } : item) };
			}
		};
		await expect(switchModel(replay.session, small)).resolves.toBe(false);
		expect(replay.events).toEqual([{ ev: "action", sf: "s:1", id: "g.bar/model", act: "status.model" }]);
		expect(bridge.toast).toHaveBeenCalledWith({ tone: "err", message: "Fixture model disabled" });
	});

	it("does not write when the thinking action declaration is missing", async () => {
		const replay = new Replay("thinking-cycle");
		replay.mutate = snapshot => {
			for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) {
				if (node.p?.actions?.click === "thinking.cycle") node.p.actions = undefined;
			}
		};
		await expect(setThinking(replay.session, "high", [])).resolves.toBe(false);
		expect(replay.events).toEqual([]);
	});

	it("refuses both controls with a distinct approval explanation before writing", async () => {
		const replay = new Replay("model-switch");
		replay.requests = [{ reqId: 4, kind: "select", title: "Run command?", options: ["Approve Once", "Deny"] }];
		replay.publish();
		await expect(switchModel(replay.session, small)).resolves.toBe(false);
		await expect(setThinking(replay.session, "high", [])).resolves.toBe(false);
		expect(replay.events).toEqual([]);
		expect(bridge.toast.mock.calls.every(([value]) => value.message === "Answer the approval card before changing the model or thinking level.")).toBe(true);
	});

	it("cancels a waiting switch after a room changes", async () => {
		const replay = new Replay("model-switch"); replay.autoConfirm = false;
		const switching = switchModel(replay.session, small);
		await vi.advanceTimersByTimeAsync(100);
		replay.generation = 2; replay.publish();
		await expect(switching).resolves.toBe(false);
		expect(bridge.toast).toHaveBeenCalledWith({ tone: "err", message: expect.stringContaining("The chat changed") });
		expect(bridge.listeners.size).toBe(0);
	});

	it("replays effort actions through Auto and resolved levels without keys", async () => {
		const replay = new Replay("thinking-cycle");
		await expect(setThinking(replay.session, "auto", [])).resolves.toBe(true);
		expect(semanticThinking(replay.snapshot())).toBe("auto");
		await expect(setThinking(replay.session, "high", [])).resolves.toBe(true);
		expect(semanticThinking(replay.snapshot())).toBe("high");
		expect(replay.events).toHaveLength(5);
		expect(replay.events.every(event => event.ev === "action" && event.act === "thinking.cycle")).toBe(true);
	});

	it("stops after one recorded cycle and explains an unsupported level distinctly", async () => {
		const replay = new Replay("thinking-cycle");
		await expect(setThinking(replay.session, "max", [])).resolves.toBe(false);
		expect(replay.events).toHaveLength(7);
		expect(semanticThinking(replay.snapshot())).toBe("off");
		expect(bridge.toast).toHaveBeenCalledWith({ tone: "err", message: "This model does not offer the Max thinking level." });
	});

	it("keeps waiting while recorded compaction remains active beyond five minutes and then confirms", async () => {
		const replay = new Replay("model-switch-compact"); replay.confirmDelay = 365000; replay.responseDelay = 360000;
		let finished = false;
		const switching = switchModel(replay.session, small).then(result => { finished = true; return result; });
		await vi.advanceTimersByTimeAsync(310000);
		expect(finished).toBe(false);
		await vi.advanceTimersByTimeAsync(51000);
		expect(finished).toBe(false);
		await expect(settle(switching, 5000)).resolves.toBe(true);
		expect(bridge.toast).not.toHaveBeenCalled();
	});

	it("ends a failed compaction without claiming the model changed", async () => {
		const replay = new Replay("model-switch-compact-error"); replay.autoConfirm = false;
		await expect(switchModel(replay.session, small)).resolves.toBe(false);
		expect(replay.model.id).toBe("fixture-large");
	});

	it("bounds collab confirmation after recorded compaction has ended", async () => {
		const replay = new Replay("model-switch-compact"); replay.autoConfirm = false; replay.responseDelay = 10000;
		let finished = false;
		const switching = switchModel(replay.session, small).then(result => { finished = true; return result; });
		await vi.advanceTimersByTimeAsync(17000);
		expect(finished).toBe(false);
		await expect(settle(switching, 1001)).resolves.toBe(false);
		expect(bridge.toast).toHaveBeenCalledWith({ tone: "warn", message: expect.stringContaining("Open the omp screen") });
	});

	it("selects an exact model version through the provider tree and completes the recorded switch", async () => {
		const replay = new Replay("model-switch");
		const element = document.createElement("div"); document.body.append(element);
		const root = createRoot(element); const done = vi.fn();
		try {
			await act(async () => root.render(createElement(TooltipProvider, null, createElement(ModelList, { projectPath: "/tmp", current: large, session: replay.session, onDone: done, onPick: model => switchModel(replay.session, model) }))));
			const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
			await act(async () => {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-small");
				input.dispatchEvent(new Event("input", { bubbles: true }));
			});
			const row = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(row => row.getAttribute("aria-label")?.startsWith("Fixture small"))!;
			await act(async () => { row.querySelector<HTMLElement>("[data-model-row]")!.click(); await vi.advanceTimersByTimeAsync(100); });
			expect(replay.events.map(event => event.ev)).toEqual(["action", "activate"]);
			expect(done).toHaveBeenCalledOnce();
		} finally { await act(async () => root.unmount()); element.remove(); }
	});

	it("changes the thinking menu label from recorded semantic effort", async () => {
		const replay = new Replay("thinking-cycle");
		const element = document.createElement("div"); document.body.append(element);
		const root = createRoot(element);
		try {
			await act(async () => root.render(createElement(TooltipProvider, null, createElement(ThinkingButton, { session: replay.session }))));
			const trigger = element.querySelector<HTMLButtonElement>('button[aria-label=\"Thinking level: Off\"]')!;
			await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse", ctrlKey: false })); });
			const choice = [...document.querySelectorAll<HTMLElement>('[role=\"menuitemradio\"]')].find(row => row.textContent?.includes("Auto"))!;
			await act(async () => { choice.click(); });
			expect(replay.events).toHaveLength(1);
			expect(element.querySelector('button[aria-label=\"Thinking level: Auto\"]')).not.toBeNull();
			expect(bridge.toast).not.toHaveBeenCalled();
		} finally { await act(async () => root.unmount()); element.remove(); }
	});
});
