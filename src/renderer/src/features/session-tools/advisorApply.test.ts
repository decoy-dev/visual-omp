// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvisorScope } from "@shared/contracts/advisor";
import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { advisorActionEvents, advisorOverlay, type TspAdvisorAction } from "@shared/tsp/advisor";
import { composer, openOverlay, screenSurface, unclaimed } from "@shared/tsp/view-state";
import type { SessionController } from "../../state/session";
import { FixtureDocuments, loadFixtureRecording, type FixtureInput } from "../tsp/testing/documents";
import { presentationClaims } from "../../state/tsp/presentation-claims";
import { screenActivity } from "../../state/tsp/screen-activity";
import { applyAdvisorConfig } from "./advisorApply";
import { AdvisorEditor } from "./AdvisorSheet";
import "../../i18n";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Set<(patch: TspHostPatch) => void>(), toast: vi.fn() }));
vi.mock("../../state/app", () => ({ controllerFor: vi.fn() }));
vi.mock("./pickers", () => ({ ModelList: () => null }));
vi.mock("@/ui", async () => {
	// Vitest hoists this factory before the static React import initializes.
	const { createElement: e } = await import("react");
	return {
		Button: ({ children, onClick, disabled }: PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) => e("button", { disabled, onClick }, children),
		Input: ({ label, ...props }: { label: string }) => e("input", { ...props, "aria-label": label }), Textarea: () => null,
		Spinner: () => null, EmptyState: () => null, Switch: () => null, Checkbox: () => null, Popover: () => null, PopoverContent: () => null, PopoverTrigger: () => null,
		Select: ({ children, onValueChange, ...props }: PropsWithChildren<{ onValueChange(value: string): void }>) => e("select", { ...props, onChange: (event: { currentTarget: HTMLSelectElement }) => onValueChange(event.currentTarget.value) }, children),
		SelectItem: ({ children, value }: PropsWithChildren<{ value: string }>) => e("option", { value }, children),
		Sheet: ({ children }: PropsWithChildren) => children, SheetContent: ({ children, footer }: PropsWithChildren<{ footer: ReactNode }>) => e("section", null, children, footer),
		Dialog: () => null, DialogContent: () => null, toast: bridge.toast,
	};
});
const file = { file: "/project/WATCHDOG.yml", exists: true, content: "# preserved\nadvisors: []\n", doc: { advisors: [] } };
class Replay {
	readonly recording;
	readonly docs = new FixtureDocuments();
	readonly listeners = new Set<() => void>();
	guest = {};
	readonly events: TspRendererEvent[] = [];
	index = 0; message = 0; revision = 0; generation = 1;
	readOnly = false;
	defer = false;
	refuse: Error | null = null;
	refuseClose = false;
	mutate: ((snapshot: TspHostSnapshot) => void) | null = null;
	view = this.readView();
	readView() { return { mode: "live", working: false, readOnly: this.readOnly, host: { hostId: "host", sessionId: "session", generation: this.generation, transport: "tsp" }, guest: { phase: "live", entries: [], state: {} } }; }
	constructor(scope: AdvisorScope = "user") {
		this.recording = loadFixtureRecording(scope === "user" ? "advisor-apply" : "advisor-apply-project");
		// DA1 responses are protocol housekeeping rather than application input.
		this.recording.inputs = this.recording.inputs.filter(input => !("keys" in input));
		this.advance();
		bridge.invoke.mockImplementation(async (channel: string, _host: string, generation: number, action: TspAdvisorAction, epoch: number) => {
			if (channel === "host:tsp-snapshot") return this.snapshot();
			if (channel === "advisor:read" || channel === "advisor:save" || channel === "advisor:finishApply") return structuredClone(file);
			if (channel === "advisor:beginApply") return "preservation-token";
			if (channel === "host:tsp-advisor") {
				expect(generation).toBe(1); expect(epoch).toBe(1);
				expect(screenActivity.has(this.snapshot(), "drive")).toBe(true);
				if (action.act === "close" && this.refuseClose) throw new Error("omp refused Close");
				if (this.refuse) throw this.refuse;
				const target = advisorOverlay(this.snapshot().surfaces)!;
				expect(presentationClaims.getSnapshot()).toContainEqual({ hostId: "host", epoch: 1, surfaceId: target.surface.open.id, nodeId: target.node.id });
				for (const event of advisorActionEvents(target, action)) this.consume(event);
			}
			if (["host:screen", "host:buffer", "host:tui-focus", "host:keys"].includes(channel)) throw new Error("Painted reads and keys are forbidden in TSP advisor apply");
			return null;
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
		const docs = structuredClone(this.docs.snapshot());
		const available = !!composer(docs.surfaces) && !openOverlay(docs.surfaces) && !screenSurface(docs.surfaces);
		const snapshot: TspHostSnapshot = { ...docs, hostId: "host", generation: this.generation, revision: ++this.revision, lifecycle: "live", documentGeneration: this.generation, failure: null, availability: { available, reason: available ? null : "Close the omp menu." }, surfaces: docs.surfaces.map(surface => ({ ...surface, documentGeneration: this.generation })) };
		this.mutate?.(snapshot);
		return snapshot;
	}
	publish() {
		this.view = this.readView();
		const patch = tspHostPatch(null, this.snapshot());
		for (const listener of bridge.listeners) listener(patch);
		for (const listener of this.listeners) listener();
	}
	consume(event: TspRendererEvent) {
		expect(screenActivity.has(this.snapshot(), "drive")).toBe(true);
		expect(event).toEqual((this.recording.inputs[this.index] as Extract<FixtureInput, { verb: "e" }>).body);
		this.events.push(event); this.index++;
		if (!this.defer || event.ev !== "action" || event.act !== "close") this.advance();
	}
	readonly session = {
		hostId: "host", tabId: "advisor", projectPath: "/project", whenLive: async () => {}, guestClient: () => this.guest,
		getSnapshot: () => this.view, subscribe: (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); },
		command: async (text: string) => { const target = composer(this.docs.snapshot().surfaces)!; this.consume({ ev: "send", sf: target.surface.open.id, id: target.node.id, text }); },
	} as unknown as SessionController;
}
beforeEach(() => {
	vi.useFakeTimers(); bridge.invoke.mockReset(); bridge.listeners.clear(); bridge.toast.mockClear();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.assign(window, { vomp: { invoke: bridge.invoke, on: (channel: string, listener: (patch: TspHostPatch) => void) => { if (channel === "host:tsp-patch") bridge.listeners.add(listener); return () => bridge.listeners.delete(listener); } } });
});
afterEach(async () => {
	await act(async () => {});
	expect(screenActivity.has({ hostId: "host", generation: 1, epoch: 1 }, "drive")).toBe(false);
	vi.useRealTimers();
});

it.each(["user", "project"] as const)("replays %s advisor apply by declared ids and finishes preservation after departure", async scope => {
	const replay = new Replay(scope); replay.defer = true;
	let finished = false;
	const applying = applyAdvisorConfig(replay.session, scope).then(result => { finished = true; return result; });
	await vi.advanceTimersByTimeAsync(10);
	expect(finished).toBe(false);
	expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "advisor:finishApply")).toHaveLength(0);
	expect(replay.events.map(event => event.ev === "action" ? event.act : event.ev)).toEqual(scope === "user" ? ["send", "scope", "save", "close"] : ["send", "save", "close"]);
	replay.advance();
	await expect(applying).resolves.toEqual(file);
	expect(bridge.invoke).toHaveBeenCalledWith("advisor:beginApply", "/project", scope);
	expect(bridge.invoke).toHaveBeenCalledWith("advisor:finishApply", "preservation-token");
	expect(presentationClaims.getSnapshot()).toEqual([]);
	expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
	expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
	expect(bridge.invoke.mock.calls.some(([channel]) => ["host:screen", "host:buffer", "host:keys", "host:tui-focus"].includes(channel))).toBe(false);
});

it("restores the preservation transaction once when the writer refuses an advisor action", async () => {
	const replay = new Replay(); replay.refuse = new Error("The advisor configuration scope changed before applying. Try again.");
	await expect(applyAdvisorConfig(replay.session, "user")).rejects.toThrow("scope changed");
	expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "advisor:finishApply")).toEqual([["advisor:finishApply", "preservation-token"]]);
	expect(presentationClaims.getSnapshot()).toEqual([]);
	expect(screenActivity.has(replay.snapshot(), "drive")).toBe(false);
});

it("cancels advisor completion on room rotation and releases its exact claim", async () => {
	const replay = new Replay(); replay.defer = true;
	const scope = replay.snapshot();
	const applying = applyAdvisorConfig(replay.session, "user");
	const rejected = expect(applying).rejects.toThrow("chat changed");
	await vi.advanceTimersByTimeAsync(10);
	replay.generation++; replay.publish();
	await rejected;
	expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "advisor:finishApply")).toHaveLength(1);
	expect(presentationClaims.getSnapshot()).toEqual([]);
	expect(screenActivity.has(scope, "drive")).toBe(false);
});

describe.each(["command", "scope", "apply", "finish", "cleanup"] as const)("pending advisor %s", stage => {
	it.each(["generation", "epoch", "guest", "lifecycle", "readOnly", "closing"] as const)("releases its drive immediately on %s invalidation", async change => {
		const replay = new Replay();
		const pending = Promise.withResolvers<void>();
		const invoke = bridge.invoke.getMockImplementation()!;
		if (stage === "command") vi.spyOn(replay.session, "command").mockImplementation(() => pending.promise);
		else bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
			if ((stage === "finish" || stage === "cleanup") && channel === "advisor:finishApply") return pending.promise.then(() => structuredClone(file));
			const action = args[2] as TspAdvisorAction | undefined;
			if (channel === "host:tsp-advisor" && (stage === "scope" && action?.act === "scope" || stage === "apply" && action?.act === "apply")) return pending.promise;
			return invoke(channel, ...args);
		});
		if (stage === "cleanup") replay.refuse = new Error("Advisor action refused");
		const scope = replay.snapshot();
		let finished = false;
		const applying = applyAdvisorConfig(replay.session, "user").then(
			result => { finished = true; return result; },
			error => { finished = true; return error; },
		);
		await vi.advanceTimersByTimeAsync(10);
		expect(screenActivity.has(scope, "drive")).toBe(true);
		if (stage === "command") expect(replay.session.command).toHaveBeenCalledWith("/advisor configure");
		else if (stage === "finish" || stage === "cleanup") expect(bridge.invoke.mock.calls.some(([channel]) => channel === "advisor:finishApply")).toBe(true);
		else {
			expect(bridge.invoke.mock.calls.some(([channel, , , action]) => channel === "host:tsp-advisor" && action.act === stage)).toBe(true);
			expect(presentationClaims.getSnapshot()).toHaveLength(1);
		}
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
		expect(presentationClaims.getSnapshot()).toEqual([]);
		if (stage === "finish" || stage === "cleanup") pending.resolve();
		else pending.reject(new Error("Pending native write refused"));
		const result = await applying;
		if (stage === "finish") expect(result).toEqual(file);
		else expect(result).toBeInstanceOf(Error);
		expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "advisor:finishApply")).toHaveLength(1);
		expect(presentationClaims.getSnapshot()).toEqual([]);
		expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(0);
	});
});

it("does not mistake overlay closure without a fresh saved confirmation for successful application", async () => {
	const replay = new Replay();
	replay.mutate = snapshot => { for (const surface of snapshot.surfaces) for (const region of surface.document.c ?? []) region.c = region.c?.filter(node => node.k !== "toast"); };
	const applying = applyAdvisorConfig(replay.session, "user");
	const rejected = expect(applying).rejects.toThrow("did not confirm");
	await vi.advanceTimersByTimeAsync(8100); await rejected;
	expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "advisor:finishApply")).toHaveLength(1);
});

it("rejects a retained saved toast whose text did not change, including TTL-only updates", async () => {
	const replay = new Replay();
	replay.mutate = snapshot => {
		const surface = snapshot.surfaces.find(surface => surface.open.id === "s:1")!;
		const main = surface.document.c!.find(region => region.id === "main")!;
		main.c = [...(main.c ?? []).filter(node => node.id !== "l"), { id: "l", k: "toast", p: { text: "Saved user WATCHDOG.yml. Run /advisor on to activate the configured advisors.", role: "omp.toast.status", ttl: replay.message } }];
	};
	const applying = applyAdvisorConfig(replay.session, "user");
	const rejected = expect(applying).rejects.toThrow("did not confirm");
	await vi.advanceTimersByTimeAsync(8100); await rejected;
	expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "advisor:finishApply")).toHaveLength(1);
});

it("uses the TSP host selected when a saved chat starts before preparing the file", async () => {
	const replay = new Replay("project");
	let started = false;
	const session = { ...replay.session, getSnapshot: () => started ? replay.view : { ...replay.view, mode: "saved", host: null }, whenLive: async () => { started = true; } } as unknown as SessionController;
	await expect(applyAdvisorConfig(session, "project")).resolves.toEqual(file);
	expect(started).toBe(true);
	expect(replay.events.map(event => event.ev === "action" ? event.act : event.ev)).toEqual(["send", "save", "close"]);
});

it("keeps the AdvisorSheet busy until TSP apply confirms, then clears its pending application", async () => {
	const replay = new Replay(); replay.defer = true;
	const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
	try {
		await act(async () => root.render(createElement(AdvisorEditor, { session: replay.session, close: vi.fn() })));
		await act(async () => { const select = element.querySelector('select[aria-label="Configuration scope"]') as HTMLSelectElement; select.value = "user"; select.dispatchEvent(new Event("change", { bubbles: true })); });
		await act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === "Add advisor")!.click());
		await act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === "Save and apply")!.click());
		expect(bridge.toast).not.toHaveBeenCalled();
		expect([...element.querySelectorAll("button")].filter(button => button.textContent === "Cancel").every(button => button.disabled)).toBe(true);
		await act(async () => replay.advance());
		expect(bridge.toast).toHaveBeenCalledWith({ tone: "ok", message: expect.any(String) });
		expect(element.textContent).not.toContain("Apply saved configuration");
		expect(replay.events).toHaveLength(4);
	} finally { await act(async () => root.unmount()); element.remove(); }
});

it.each(["fresh-error", "page-timeout"] as const)("keeps AdvisorSheet application pending after %s and releases its driver", async outcome => {
	const replay = new Replay(); replay.defer = true; replay.refuseClose = true;
	if (outcome === "fresh-error") replay.mutate = snapshot => {
		if (!replay.events.some(event => event.ev === "action" && event.act === "save")) return;
		const main = snapshot.surfaces.find(surface => surface.open.id === "s:1")!.document.c!.find(node => node.id === "main")!;
		main.c = [...main.c ?? [], { id: "failure", k: "toast", p: { role: "omp.toast.status", text: "Advisor config: Fixture save failed." } }];
	};
	const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
	try {
		await act(async () => root.render(createElement(AdvisorEditor, { session: replay.session, close: vi.fn() })));
		const consumerSubscriptions = replay.listeners.size;
		await act(async () => { const select = element.querySelector('select[aria-label="Configuration scope"]') as HTMLSelectElement; select.value = "user"; select.dispatchEvent(new Event("change", { bubbles: true })); });
		await act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === "Add advisor")!.click());
		await act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === "Save and apply")!.click());
		await act(async () => { replay.publish(); await vi.advanceTimersByTimeAsync(outcome === "page-timeout" ? 8100 : 1); });
		expect(bridge.toast.mock.calls.some(([notice]) => notice.tone === "ok")).toBe(false);
		expect(bridge.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "warn", description: expect.stringContaining(outcome === "fresh-error" ? "Advisor config: Fixture save failed." : "did not confirm") }));
		expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "advisor:finishApply")).toEqual([["advisor:finishApply", "preservation-token"]]);
		expect(bridge.invoke.mock.calls.some(([channel, , , action]) => channel === "host:tsp-advisor" && action.act === "close")).toBe(true);
		expect(presentationClaims.getSnapshot()).toEqual([]);
		expect(bridge.listeners.size).toBe(0); expect(replay.listeners.size).toBe(consumerSubscriptions);
		const target = advisorOverlay(replay.snapshot().surfaces)!;
		expect(target).not.toBeNull();
		expect(unclaimed(target.surface, "main")).toContainEqual(target.node);
		expect([...element.querySelectorAll("button")].find(button => button.textContent === "Apply saved configuration")?.disabled).toBe(false);
	} finally { await act(async () => root.unmount()); element.remove(); }
	expect(replay.listeners.size).toBe(0);
});
