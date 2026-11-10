// @vitest-environment happy-dom
import type { ModelInfo } from "@shared/contracts/config";
import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { composer, openOverlay, walkNodes } from "@shared/tsp/view-state";
import { TSP_ROLES } from "@shared/tsp/roles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { FixtureDocuments, loadFixtureRecording, type FixtureInput } from "../tsp/testing/documents";
import type { SessionController } from "../../state/session";
import { screenActivity } from "../../state/tsp/screen-activity";
import type { CollabUiRequest, SessionEntry } from "@oh-my-pi/pi-wire";
import { switchModel, setThinking } from "./model";
import { semanticThinking } from "./modelTsp";
import { ModelList, ThinkingButton } from "./pickers";
import { TooltipProvider } from "../../ui/Tooltip";
import { i18n } from "../../i18n";
import settingsMessages from "../../i18n/en/settings.json";
import { ThinkingStatusItem } from "../../shell/statusbar/ChatStatusItems";
import type { ThinkingEvent } from "./thinking";

const bridge = vi.hoisted(() => {
	const state = { invoke: vi.fn(), listeners: new Set<(patch: TspHostPatch) => void>(), toast: vi.fn() };
	Object.defineProperty(window, "vomp", { configurable: true, value: {
		on: (channel: string, listener: (patch: TspHostPatch) => void) => {
			if (channel === "host:tsp-patch") state.listeners.add(listener);
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
	guest = {};
	index = 0;
	message = 0;
	revision = 0;
	model = large;
	transport: "tsp" | "classic" = "tsp";
	requests: CollabUiRequest[] = [];
	thinkingSelector: string | null = null;
	thinkingEvent: ThinkingEvent | null = null;
	entries: SessionEntry[] = [];
	generation = 1;
	readOnly = false;
	autoConfirm = true;
	confirmDelay = 0;
	responseDelay = 0;
	mutate: ((snapshot: TspHostSnapshot) => void) | null = null;
	beforeEvent: ((event: TspRendererEvent) => void) | null = null;
	view = this.readView();
	readView() {
		return { mode: "live", readOnly: this.readOnly, host: { hostId: "host", generation: this.generation, sessionId: "session", transport: this.transport }, guest: { phase: "live", thinkingSelector: this.thinkingSelector, thinkingEvent: this.thinkingEvent, entries: this.entries, pendingUiRequests: this.requests, uiRequest: this.requests[0] ?? null, state: { model: this.model, contextUsage: { tokens: 0 } } } };
	}
	constructor(name: string) {
		this.recording = loadFixtureRecording(name);
		this.advance();
		bridge.invoke.mockImplementation(async (channel: string, _host: string, generation: number, event: TspRendererEvent, epoch: number) => {
			if (channel === "host:tsp-snapshot") return this.snapshot();
			if (channel === "host:tsp-event") {
				expect(generation).toBe(1); expect(epoch).toBe(1);
				expect(screenActivity.has(this.snapshot(), "drive")).toBe(true);
				this.beforeEvent?.(event);
				this.consume(event);
			}
			if (channel === "config:models") return [large, small];
			if (channel === "host:screen" && this.transport === "classic") return [" π ▶ ⬢ Fixture · ◔ low ▶─0%─", "╰─ "];
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
		const document = structuredClone(this.docs.snapshot());
		const available = !!composer(document.surfaces) && !openOverlay(document.surfaces);
		const snapshot: TspHostSnapshot = { ...document, hostId: "host", generation: 1, revision: ++this.revision, lifecycle: "live", documentGeneration: 1, failure: null,
			availability: { available, reason: available ? null : "Close omp's menu first." }, surfaces: document.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
		this.mutate?.(snapshot);
		return snapshot;
	}
	publish(): void {
		this.view = this.readView();
		const snapshot = this.snapshot();
		for (const listener of bridge.listeners) listener(tspHostPatch(null, snapshot));
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
			expect(screenActivity.has(this.snapshot(), "drive")).toBe(true);
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
afterEach(async () => {
	await act(async () => {});
	expect(screenActivity.has({ hostId: "host", generation: 1, epoch: 1 }, "drive")).toBe(false);
	vi.useRealTimers();
});

async function settle<T>(promise: Promise<T>, milliseconds = 10000): Promise<T> {
	await vi.advanceTimersByTimeAsync(milliseconds);
	return promise;
}

/** Keep the recorded picker frames, but delay the action's publication past typed fallback. */
function delayedModelPicker(delay: number | null, closeDelay: number | null = 200): Replay {
	const replay = new Replay("model-switch");
	const advance = replay.advance.bind(replay);
	replay.consume = event => {
		replay.events.push(event);
		if (event.ev === "action" && event.act === "status.model" && delay !== null) {
			setTimeout(() => { replay.index = 1; advance(); }, delay);
		} else if (event.ev === "action" && event.act === "close" && closeDelay !== null) {
			setTimeout(() => { replay.index = 2; advance(); }, closeDelay);
		}
	};
	vi.spyOn(replay.session, "command").mockImplementation(async text => {
		expect(text).toBe(`/switch ${small.selector}`);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(true);
		const editor = composer(replay.docs.snapshot().surfaces)!;
		replay.events.push({ ev: "send", sf: editor.surface.open.id, id: editor.node.id, text });
		setTimeout(() => { replay.model = small; replay.publish(); }, replay.confirmDelay);
	});
	return replay;
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

	it("holds a roleless model picker beyond the automatic screen settle interval", async () => {
		const replay = new Replay("model-switch");
		const advance = replay.advance.bind(replay);
		const consume = replay.consume.bind(replay);
		replay.consume = event => {
			if (event.ev === "action" && event.act === "close") replay.events.push(event);
			else consume(event);
		};
		replay.beforeEvent = event => {
			if (event.ev === "activate") replay.advance = () => { setTimeout(advance, 750); };
		};
		const switching = switchModel(replay.session, small);
		await vi.advanceTimersByTimeAsync(500);
		expect(replay.events.map(event => event.ev)).toEqual(["action", "activate", "action"]);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(true);
		await vi.advanceTimersByTimeAsync(251);
		await expect(switching).resolves.toBe(true);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
	});

	it("does not report success from a closed picker alone", async () => {
		const replay = new Replay("model-switch"); replay.autoConfirm = false;
		await expect(settle(switchModel(replay.session, small))).resolves.toBe(false);
		expect(bridge.toast).toHaveBeenCalledWith({ tone: "warn", message: expect.stringContaining("Open the omp screen") });
	});

	it("closes its picker when collab confirms the switch before the picker disappears", async () => {
		const replay = new Replay("model-switch");
		const advance = replay.advance.bind(replay);
		const consume = replay.consume.bind(replay);
		replay.beforeEvent = event => { if (event.ev === "activate") replay.advance = () => { replay.model = small; replay.publish(); }; };
		replay.consume = event => {
			if (event.ev === "action" && event.act === "close") { replay.events.push(event); replay.index = 2; advance(); }
			else consume(event);
		};
		await expect(settle(switchModel(replay.session, small))).resolves.toBe(true);
		expect(replay.events.at(-1)).toEqual({ ev: "action", sf: "s:1", id: "j", act: "close" });
		expect(bridge.toast).not.toHaveBeenCalled();
	});

	it("bounds one declared close attempt when a confirmed model picker never closes", async () => {
		const replay = new Replay("model-switch");
		const consume = replay.consume.bind(replay);
		replay.beforeEvent = event => { if (event.ev === "activate") replay.advance = () => { replay.model = small; replay.publish(); }; };
		replay.consume = event => {
			if (event.ev === "action" && event.act === "close") { replay.events.push(event); replay.publish(); }
			else consume(event);
		};
		let finished = false;
		const switching = switchModel(replay.session, small).then(result => { finished = true; return result; });
		await vi.advanceTimersByTimeAsync(2499);
		expect(finished).toBe(false);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(true);
		await vi.advanceTimersByTimeAsync(2);
		await expect(switching).resolves.toBe(false);
		expect(replay.model).toBe(small);
		expect(replay.events.filter(event => event.ev === "action" && event.act === "close")).toEqual([{ ev: "action", sf: "s:1", id: "j", act: "close" }]);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
		expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
	});

	it.each([0, 1000])("closes a late picker under its drive lease with collab delayed %s ms after fallback", async confirmDelay => {
		const replay = delayedModelPicker(3000); replay.confirmDelay = confirmDelay;
		let finished = false;
		const switching = switchModel(replay.session, small).then(result => { finished = true; return result; });
		await vi.advanceTimersByTimeAsync(2750);
		expect(replay.events.map(event => event.ev)).toEqual(["action", "send"]);
		expect(finished).toBe(false);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(true);
		await vi.advanceTimersByTimeAsync(300);
		expect(replay.events.at(-1)).toEqual({ ev: "action", sf: "s:1", id: "j", act: "close" });
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(true);
		await expect(settle(switching, 1000)).resolves.toBe(true);
		expect(bridge.toast).not.toHaveBeenCalled();
		expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
	});

	it("ends the bounded late-picker grace when no picker arrives", async () => {
		const replay = delayedModelPicker(null);
		let finished = false;
		const switching = switchModel(replay.session, small).then(result => { finished = true; return result; });
		await vi.advanceTimersByTimeAsync(3499);
		expect(finished).toBe(false);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(true);
		await vi.advanceTimersByTimeAsync(2);
		await expect(switching).resolves.toBe(true);
		expect(replay.events.map(event => event.ev)).toEqual(["action", "send"]);
		expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
	});

	it.each([2700, 3100])("does not claim success when an error arrives at %s ms during picker cleanup", async errorAt => {
		const replay = delayedModelPicker(3000, 400);
		let failed = false;
		replay.mutate = snapshot => {
			if (!failed) return;
			const main = snapshot.surfaces[0]!.document.c!.find(node => node.id === "main")!;
			main.c = [...(main.c ?? []), { id: "late-error", k: "text", p: { role: TSP_ROLES.noticeError, text: "Switch failed during cleanup" } }];
		};
		const switching = switchModel(replay.session, small);
		setTimeout(() => { failed = true; replay.publish(); }, errorAt);
		await expect(settle(switching, 4000)).resolves.toBe(false);
		expect(replay.model).toBe(small);
		expect(replay.events.filter(event => event.ev === "action" && event.act === "close")).toHaveLength(1);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
	});

	it("finishes late-picker grace before releasing its drive for compaction that starts during cleanup", async () => {
		const replay = delayedModelPicker(null);
		let compacting = false;
		replay.mutate = snapshot => {
			if (!compacting) return;
			const main = snapshot.surfaces[0]!.document.c!.find(node => node.id === "main")!;
			main.c = [...(main.c ?? []), { id: "late-compaction", k: "row", p: { role: TSP_ROLES.working }, c: [{ id: "late-progress", k: "progress" }] }];
		};
		let finished = false;
		const switching = switchModel(replay.session, small).then(result => { finished = true; return result; });
		await vi.advanceTimersByTimeAsync(2800);
		compacting = true; replay.model = large; replay.publish();
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(true);
		await vi.advanceTimersByTimeAsync(701);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
		expect(finished).toBe(false);
		await vi.advanceTimersByTimeAsync(5000);
		expect(finished).toBe(false);
		compacting = false; replay.publish();
		await vi.advanceTimersByTimeAsync(500);
		expect(finished).toBe(false);
		replay.model = small; replay.publish();
		await expect(switching).resolves.toBe(true);
		expect(replay.events.map(event => event.ev)).toEqual(["action", "send"]);
		expect(bridge.toast).not.toHaveBeenCalled();
	});

	it.each(["generation", "epoch"] as const)("never closes a late picker in a replacement %s", async change => {
		const replay = delayedModelPicker(3000);
		const scope = replay.snapshot();
		const switching = switchModel(replay.session, small);
		await vi.advanceTimersByTimeAsync(2700);
		if (change === "generation") replay.generation++;
		else replay.mutate = snapshot => { snapshot.epoch++; };
		replay.publish();
		await expect(switching).resolves.toBe(false);
		await vi.advanceTimersByTimeAsync(500);
		expect(replay.events.map(event => event.ev)).toEqual(["action", "send"]);
		expect(screenActivity.has(scope, "drive")).toBe(false);
		expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
	});

	it("leaves a model picker that was already open untouched", async () => {
		const replay = new Replay("model-switch");
		replay.consume({ ev: "action", sf: "s:1", id: "g.bar/model", act: "status.model" });
		replay.events.length = 0;
		await expect(switchModel(replay.session, small)).resolves.toBe(false);
		expect(replay.events).toEqual([]);
		expect(replay.snapshot().surfaces.some(surface => [...walkNodes(surface.document)].some(node => node.k === "picker" && node.p?.noun === "models"))).toBe(true);
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
		const activation = replay.recording.inputs[1]!;
		if (!("verb" in activation)) throw new Error("Expected semantic activation fixture input");
		activation.body = { ev: "action", sf: "s:1", id: "j", act: "close" };
		await expect(switchModel(replay.session, small)).resolves.toBe(false);
		expect(replay.events).toEqual([{ ev: "action", sf: "s:1", id: "g.bar/model", act: "status.model" }, { ev: "action", sf: "s:1", id: "j", act: "close" }]);
		expect(bridge.toast).toHaveBeenCalledWith({ tone: "err", message: "Fixture model disabled" });
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
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

	it.each(["generation", "epoch"] as const)("cancels a held model picker after a %s change", async change => {
		const replay = new Replay("model-switch"); replay.autoConfirm = false;
		replay.beforeEvent = event => { if (event.ev === "activate") replay.advance = () => { replay.publish(); }; };
		const switching = switchModel(replay.session, small);
		const scope = replay.snapshot();
		await vi.advanceTimersByTimeAsync(500);
		expect(screenActivity.has(scope, "drive")).toBe(true);
		if (change === "generation") replay.generation++;
		else replay.mutate = snapshot => { snapshot.epoch++; };
		replay.publish();
		await expect(switching).resolves.toBe(false);
		expect(bridge.toast).toHaveBeenCalledWith({ tone: "err", message: expect.stringContaining("The chat changed") });
		expect(bridge.listeners.size).toBe(0);
		expect(screenActivity.has(scope, "drive")).toBe(false);
	});

	describe.each(["model", "typed", "thinking"] as const)("pending %s write", control => {
		it.each(["generation", "epoch", "guest", "lifecycle", "readOnly", "closing"] as const)("releases its drive immediately on %s invalidation", async change => {
			const replay = new Replay(control === "thinking" ? "thinking-cycle" : control === "typed" ? "switch-typed" : "model-switch");
			const pending = Promise.withResolvers<void>();
			if (control === "typed") {
				replay.mutate = snapshot => {
					for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) if (node.p?.role === "omp.composer.model") node.p.actions = undefined;
				};
				vi.spyOn(replay.session, "command").mockImplementation(() => pending.promise);
			} else {
				const invoke = bridge.invoke.getMockImplementation()!;
				bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === "host:tsp-event" ? pending.promise : invoke(channel, ...args));
			}
			const scope = replay.snapshot();
			let finished = false;
			const changing = (control === "thinking" ? setThinking(replay.session, "high", []) : switchModel(replay.session, small)).then(result => { finished = true; return result; });
			await vi.advanceTimersByTimeAsync(10);
			expect(screenActivity.has(scope, "drive")).toBe(true);
			if (control === "typed") expect(replay.session.command).toHaveBeenCalledWith(`/switch ${small.selector}`);
			else expect(bridge.invoke.mock.calls.some(([channel]) => channel === "host:tsp-event")).toBe(true);
			if (change === "generation") replay.generation++;
			else if (change === "guest") replay.guest = {};
			else if (change === "readOnly") replay.readOnly = true;
			else replay.mutate = snapshot => {
				if (change === "epoch") snapshot.epoch++;
				else if (change === "lifecycle") snapshot.lifecycle = "transitioning";
				else snapshot.closing = true;
			};
			replay.publish();
			expect(finished).toBe(false);
			expect(screenActivity.has(scope, "drive")).toBe(false);
			pending.reject(new Error("Pending native write refused"));
			await expect(changing).resolves.toBe(false);
			expect(replay.events).toEqual([]);
			expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
		});
	});

	it("replays effort actions through Auto and resolved levels without keys", async () => {
		const replay = new Replay("thinking-cycle");
		await expect(setThinking(replay.session, "auto", [])).resolves.toBe(true);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
		expect(semanticThinking(replay.snapshot(), replay.thinkingSelector, replay.entries)).toBe("auto");
		await expect(setThinking(replay.session, "high", [])).resolves.toBe(true);
		expect(semanticThinking(replay.snapshot(), replay.thinkingSelector, replay.entries)).toBe("high");
		expect(replay.events).toHaveLength(5);
		expect(replay.events.every(event => event.ev === "action" && event.act === "thinking.cycle")).toBe(true);
	});

	it.each(["inline", "separate"] as const)("continues from the first Off receipt without a glyph change in a %s effort control", async shape => {
		const replay = new Replay("thinking-cycle");
		const original = replay.snapshot().surfaces.flatMap(surface => [...walkNodes(surface.document)]).find(node => node.k === "effort")!;
		const targetId = shape === "separate" ? "h.bar/effort" : original.id;
		const levels = ["off", "auto", "minimal", "low", "medium", "high"] as const;
		let displayed: typeof levels[number] = "off";
		let step = 0;
		replay.mutate = snapshot => {
			for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) {
				if (node.id === original.id && node.k === "effort") node.p = { ...node.p, level: displayed };
				if (shape === "separate" && node.c) node.c = node.c.map(child => child.id === original.id ? {
					id: targetId, k: "row", p: { role: "omp.composer.effort", actions: { click: "thinking.cycle" } },
					c: [{ id: `${targetId}/glyph`, k: "effort", p: { level: displayed } }],
				} : child);
			}
		};
		replay.consume = event => {
			expect(event).toEqual({ ev: "action", sf: "s:1", id: targetId, act: "thinking.cycle" });
			replay.events.push(event);
			const next = levels[step++]!;
			setTimeout(() => { displayed = next; replay.thinkingSelector = next; replay.publish(); }, step === 1 ? 1200 : 20);
		};
		let finished = false;
		const changing = setThinking(replay.session, "high", []).then(result => { finished = true; return result; });
		await vi.advanceTimersByTimeAsync(1199);
		expect(replay.events).toHaveLength(1);
		expect(replay.thinkingSelector).toBeNull();
		await vi.advanceTimersByTimeAsync(2);
		expect(replay.thinkingSelector).toBe("off");
		expect(semanticThinking(replay.snapshot(), replay.thinkingSelector, replay.entries)).toBe("off");
		expect(replay.events).toHaveLength(2);
		expect(finished).toBe(false);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(true);
		await expect(settle(changing, 1000)).resolves.toBe(true);
		expect(replay.events).toHaveLength(6);
		expect(replay.thinkingSelector).toBe("high");
		expect(bridge.toast).not.toHaveBeenCalled();
		expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
	});

	it.each([null, "off"])("does not keep cycling on duplicate Off receipts after starting with %s", async initial => {
		const replay = new Replay("thinking-cycle");
		replay.thinkingSelector = initial; replay.publish();
		replay.consume = event => {
			replay.events.push(event);
			replay.thinkingSelector = "off";
			replay.thinkingEvent = { thinkingLevel: "off" };
			replay.publish();
		};
		await expect(settle(setThinking(replay.session, "high", []), 3000)).resolves.toBe(false);
		expect(replay.events).toHaveLength(initial === null ? 2 : 1);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
		expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
	});

	it.each(["timeout", "generation", "epoch", "writer"] as const)("releases a thinking cycle drive after %s failure", async failure => {
		const replay = new Replay("thinking-cycle");
		const scope = replay.snapshot();
		replay.consume = event => { replay.events.push(event); };
		if (failure === "writer") replay.beforeEvent = () => { throw new Error("Thinking action refused"); };
		const changing = setThinking(replay.session, "high", []);
		await vi.advanceTimersByTimeAsync(500);
		if (failure !== "writer") expect(screenActivity.has(scope, "drive")).toBe(true);
		if (failure === "generation") { replay.generation++; replay.publish(); }
		else if (failure === "epoch") { replay.mutate = snapshot => { snapshot.epoch++; }; replay.publish(); }
		await expect(settle(changing)).resolves.toBe(false);
		expect(screenActivity.has(scope, "drive")).toBe(false);
	});

	it.each(["event", "entry"] as const)("keeps Auto selected from its %s after omp resolves it to Low without cycling", async source => {
		const replay = new Replay("thinking-cycle");
		if (source === "event") replay.thinkingSelector = "auto";
		else replay.entries = [{ type: "thinking_level_change", id: "auto", parentId: null, timestamp: "", thinkingLevel: "low", configured: "auto" } as SessionEntry];
		replay.mutate = snapshot => {
			for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) {
				if (node.k === "effort") node.p = { ...node.p, level: "low" };
			}
		};
		replay.publish();
		await expect(settle(setThinking(replay.session, "auto", []))).resolves.toBe(true);
		expect(replay.events).toEqual([]);
		expect(bridge.toast).not.toHaveBeenCalled();
	});

	it("leaves resolved Auto for Low and waits for collab when the effort node stays Low", async () => {
		const replay = new Replay("thinking-cycle");
		replay.thinkingSelector = "auto";
		replay.mutate = snapshot => {
			for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) {
				if (node.k === "effort") node.p = { ...node.p, level: "low" };
			}
		};
		replay.consume = event => {
			replay.events.push(event);
			setTimeout(() => { replay.thinkingSelector = "low"; replay.publish(); }, 300);
		};
		replay.publish();
		let finished = false;
		const changing = setThinking(replay.session, "low", []).then(result => { finished = true; return result; });
		await vi.advanceTimersByTimeAsync(100);
		expect(finished).toBe(false);
		await expect(settle(changing)).resolves.toBe(true);
		expect(replay.events).toHaveLength(1);
		expect(replay.events[0]).toMatchObject({ ev: "action", act: "thinking.cycle" });
		expect(bridge.toast).not.toHaveBeenCalled();
	});

	it.each([
		["high", "collab"], ["low", "collab"], ["high", "semantic"], ["low", "semantic"],
	] as const)("selects %s from Auto resolved to High when %s updates first", async (target, first) => {
		const replay = new Replay("thinking-cycle");
		const levels = ["auto", "low", "medium", "high"] as const;
		let selected: typeof levels[number] = "auto";
		let displayed: typeof levels[number] = "high";
		replay.thinkingSelector = "auto";
		replay.mutate = snapshot => {
			for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) {
				if (node.k === "effort") node.p = { ...node.p, level: displayed };
			}
		};
		replay.consume = event => {
			replay.events.push(event);
			selected = levels[(levels.indexOf(selected) + 1) % levels.length]!;
			const next = selected;
			setTimeout(() => {
				replay.thinkingSelector = next;
				replay.publish();
			}, first === "collab" ? 100 : 300);
			setTimeout(() => { displayed = next; replay.publish(); }, first === "semantic" ? 100 : 300);
		};
		replay.publish();
		let confirmed: string | null = null;
		const changing = setThinking(replay.session, target, []).then(result => {
			confirmed = replay.thinkingSelector;
			return result;
		});
		await expect(settle(changing)).resolves.toBe(true);
		expect(confirmed).toBe(target);
		expect(selected).toBe(target);
		expect(replay.events).toHaveLength(target === "low" ? 1 : 3);
		expect(bridge.toast).not.toHaveBeenCalled();
	});

	it("stops after one recorded cycle and explains an unsupported level distinctly", async () => {
		const replay = new Replay("thinking-cycle");
		await expect(setThinking(replay.session, "max", [])).resolves.toBe(false);
		expect(replay.events).toHaveLength(7);
		expect(semanticThinking(replay.snapshot(), replay.thinkingSelector, replay.entries)).toBe("off");
		expect(bridge.toast).toHaveBeenCalledWith({ tone: "err", message: "This model does not offer the Max thinking level." });
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
	});

	it("keeps waiting while recorded compaction remains active beyond five minutes and then confirms", async () => {
		const replay = new Replay("model-switch-compact"); replay.confirmDelay = 365000; replay.responseDelay = 360000;
		let finished = false;
		const switching = switchModel(replay.session, small).then(result => { finished = true; return result; });
		await vi.advanceTimersByTimeAsync(310000);
		expect(finished).toBe(false);
		expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
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
			expect(element.querySelector('button[aria-label=\"Thinking level: Auto · Pending\"]')).not.toBeNull();
			expect(bridge.toast).not.toHaveBeenCalled();
		} finally { await act(async () => root.unmount()); element.remove(); }
	});

	it.each([["tsp", "event"], ["tsp", "entry"], ["classic", "event"], ["classic", "entry"]] as const)("labels %s resolved Auto from its %s alongside Low", async (presentation, source) => {
		const replay = new Replay("thinking-cycle");
		replay.transport = presentation;
		if (source === "event") replay.thinkingSelector = "auto";
		else replay.entries = [{ type: "thinking_level_change", id: "auto", parentId: null, timestamp: "", thinkingLevel: "low", configured: "auto" } as SessionEntry];
		replay.mutate = snapshot => {
			for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) {
				if (node.k === "effort") node.p = { ...node.p, level: "low" };
			}
		};
		replay.publish();
		const element = document.createElement("div"); document.body.append(element);
		const root = createRoot(element);
		try {
			await act(async () => root.render(createElement(TooltipProvider, null, createElement(ThinkingButton, { session: replay.session }))));
			const trigger = element.querySelector<HTMLButtonElement>('button[aria-label="Thinking level: Auto · Low"]')!;
			expect(trigger).not.toBeNull();
			expect(trigger.textContent).toBe("Auto · Low");
			await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse", ctrlKey: false })); });
			const auto = [...document.querySelectorAll('[role="menuitemradio"]')].find(row => row.textContent?.startsWith("Auto · Low"));
			expect(auto?.getAttribute("aria-checked")).toBe("true");
			expect(auto?.textContent).toContain("may choose Low for short messages");
			expect(auto?.hasAttribute("aria-label")).toBe(false);
			expect([...document.querySelectorAll('[role="menuitemradio"]')].some(row => row.textContent?.startsWith("Low"))).toBe(true);
			expect(replay.events).toEqual([]);
		} finally { await act(async () => root.unmount()); element.remove(); }
	});

	it("shows a same-model Auto reapplication as pending without cycling or a new collab event", async () => {
		i18n.addResourceBundle("en", "settings", settingsMessages);
		const replay = new Replay("thinking-cycle");
		replay.thinkingSelector = "auto";
		replay.thinkingEvent = { configured: "auto", thinkingLevel: "high", resolved: "high" };
		let effort: "high" | "auto" | "low" = "high";
		replay.mutate = snapshot => {
			for (const surface of snapshot.surfaces) for (const node of walkNodes(surface.document)) {
				if (node.k === "effort") node.p = { ...node.p, level: effort };
			}
		};
		replay.publish();
		const element = document.createElement("div"); document.body.append(element);
		const root = createRoot(element);
		try {
			await act(async () => root.render(createElement(TooltipProvider, null, createElement(ThinkingButton, { session: replay.session }))));
			expect(element.querySelector('[aria-label="Thinking level: Auto · High"]')).not.toBeNull();
			await act(async () => { effort = "auto"; replay.publish(); });
			expect(element.querySelector('[aria-label="Thinking level: Auto · Pending"]')).not.toBeNull();
			expect(replay.thinkingEvent?.resolved).toBe("high");
			await expect(setThinking(replay.session, "auto", [])).resolves.toBe(true);
			expect(replay.events).toEqual([]);
			await act(async () => root.render(null));
			await act(async () => root.render(createElement(TooltipProvider, null, createElement("div", null,
				createElement(ThinkingButton, { key: "remounted", session: replay.session }),
				createElement(ThinkingStatusItem, { key: "second-consumer", session: replay.session, projectPath: replay.session.projectPath }),
			))));
			expect(element.querySelectorAll('[aria-label="Thinking level: Auto · Pending"]')).toHaveLength(2);
			await act(async () => {
				replay.thinkingEvent = { configured: "auto", thinkingLevel: "low", resolved: "low" };
				replay.publish();
			});
			expect(element.querySelectorAll('[aria-label="Thinking level: Auto · Low"]')).toHaveLength(2);
			await act(async () => { effort = "low"; replay.publish(); });
			expect(element.querySelectorAll('[aria-label="Thinking level: Auto · Low"]')).toHaveLength(2);
		} finally { await act(async () => root.unmount()); element.remove(); }
	});
});
