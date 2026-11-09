// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import type { TspHostSnapshot, TspSurfaceSnapshot } from "@shared/tsp-host";
import { hookQuestions, matchQuestions } from "@shared/tsp/question-match";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import type { GuestClient, GuestSnapshot } from "../../collab/lib/client";
import { SessionController, type SessionView } from "../../state/session";
import { controllerFor, useApp } from "../../state/app";
import { useSessionView } from "../../shell/hooks";
import { presentationClaims } from "../../state/tsp/presentation-claims";
import { OverlayWatcher } from "../../features/palette/OverlayWatcher";
import { autoOpened } from "../../features/palette/TerminalSheet";
import { usePendingQuestion } from "./QuestionCard";
import evidence from "../../../../main/omp/tsp/fixtures/18.18.3/ask-html-form.ask.json";
import "../../i18n";

let root: Root;
let element: HTMLDivElement;
let controller: SessionController;
let view: SessionView;
let snapshot: TspHostSnapshot;
let stopApp: () => void;
let tabId: string;
const listeners = new Set<() => void>();
const hostListeners = new Set<(patch: TspHostPatch) => void>();
const opens: string[] = [];
const originalVomp = window.vomp;
const entries = evidence.sessions[0]!.text.trim().split("\n").map(line => JSON.parse(line));
const call = entries.flatMap(entry => entry.message?.content ?? []).find(part => part.type === "toolCall");
const first = evidence.stages[2]!.request as CollabUiRequest;
const next = evidence.stages[3]!.request as CollabUiRequest;

function Harness() {
	const current = useSessionView(controller);
	const pending = usePendingQuestion(controller, current?.guest?.uiRequest ?? null);
	return createElement(Fragment, null, createElement(OverlayWatcher), pending && createElement("div", { key: pending.key }, pending.node));
}
async function updateRequest(request: CollabUiRequest | null) {
	await act(async () => {
		view = { ...view, guest: { ...view.guest!, uiRequest: request, pendingUiRequests: request ? [request] : [] } };
		for (const listener of listeners) listener();
	});
}
async function publishMatches(matches: TspHostSnapshot["questionMatches"]) {
	await act(async () => {
		snapshot = { ...snapshot, revision: snapshot.revision + 1, questionMatches: matches };
		for (const listener of hostListeners) listener(tspHostPatch(null, snapshot));
	});
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	listeners.clear(); hostListeners.clear(); opens.length = 0;
	const scope = { hostId: `ask-update-${crypto.randomUUID()}`, generation: 1, epoch: 1 };
	const surfaces = (structuredClone(evidence.stages[2]!.surfaces) as unknown as TspSurfaceSnapshot[]).map(surface => ({ ...surface, documentGeneration: 1 }));
	snapshot = { ...scope, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null, availability: { available: false, reason: "Question" }, surfaces,
		questionMatches: matchQuestions(scope, { ...scope, connection: 1, revision: 1, connected: true, requests: [first] }, hookQuestions(surfaces, 1)) };
	Object.defineProperty(window, "vomp", { configurable: true, writable: true, value: { platform: "darwin", invoke: async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined,
		on: (channel: string, listener: (patch: TspHostPatch) => void) => { if (channel === "host:tsp-patch") hostListeners.add(listener); return () => hostListeners.delete(listener); } } });
	vi.spyOn(SessionController.prototype, "ensureLive").mockResolvedValue(undefined);
	useApp.setState({ tabs: [], activeTabId: null, splitTabId: null, terminalTabId: null, sheet: null, view: "chat" });
	tabId = (await useApp.getState().newChat("/tmp/vomp-fixture"))!;
	controller = controllerFor(tabId)!;
	const replica: GuestSnapshot = { phase: "live", endedReason: null, header: null, state: null, agents: [], progress: new Map(), lifecycle: new Map(), streamDone: false, backgroundTools: new Map(), notices: [], thinkingSelector: null,
		readOnly: false, loading: null, uiRequest: first, pendingUiRequests: [first], activeTools: new Map([[call.id, { toolCallId: call.id, toolName: "ask", args: call.arguments, intent: undefined, startedAt: 0 }]]), entries: [], stream: null, working: true };
	view = { ...controller.getSnapshot(), mode: "live", working: true, readOnly: false, host: { hostId: scope.hostId, generation: 1, transport: "tsp", phase: "live", cols: 110, rows: 32 }, guest: replica } as SessionView;
	vi.spyOn(controller, "getSnapshot").mockImplementation(() => view);
	vi.spyOn(controller, "subscribe").mockImplementation(listener => { listeners.add(listener); return () => listeners.delete(listener); });
	vi.spyOn(controller, "guestClient").mockReturnValue({ getSnapshot: () => view.guest! } as GuestClient);
	stopApp = useApp.subscribe((state, previous) => { if (state.terminalTabId && state.terminalTabId !== previous.terminalTabId) opens.push(state.terminalTabId); });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
	await act(async () => root.render(createElement(Harness)));
	await vi.waitFor(() => expect(presentationClaims.getSnapshot()).toHaveLength(1));
});
afterEach(async () => {
	await act(async () => root.unmount()); stopApp();
	await useApp.getState().closeTab(tabId);
	useApp.setState({ terminalTabId: null }); autoOpened.tabId = null;
	element.remove(); window.vomp = originalVomp; vi.restoreAllMocks();
});

it("retains a disabled visible card and one claim until the next field and its match arrive", async () => {
	await updateRequest(null);
	await vi.waitFor(() => expect(element.querySelector("[data-form-question]")?.getAttribute("aria-busy")).toBe("true"));
	expect(element.querySelector("fieldset")?.disabled).toBe(true);
	expect(element.textContent).toContain("Waiting for the next question from omp.");
	expect(presentationClaims.getSnapshot()).toHaveLength(1);
	await publishMatches(snapshot.questionMatches?.map(match => ({ ...match, status: "settling" })));
	await updateRequest(next);
	await vi.waitFor(() => expect(element.querySelector(`[data-question-card="${next.reqId}"]`)).not.toBeNull());
	expect(presentationClaims.getSnapshot()).toHaveLength(1);
	await publishMatches(snapshot.questionMatches?.map(match => ({ ...match, reqId: next.reqId })));
	expect(opens).toEqual([]);
	expect(useApp.getState().terminalTabId).toBeNull();
});

it("releases the form for uncertain matching and can claim it again after matching recovers", async () => {
	const matched = snapshot.questionMatches;
	await publishMatches(matched?.map(match => ({ ...match, status: "ambiguous", reqId: undefined })));
	await vi.waitFor(() => expect(opens).toHaveLength(1));
	expect(presentationClaims.getSnapshot()).toEqual([]);
	await publishMatches(matched);
	await vi.waitFor(() => expect(useApp.getState().terminalTabId).toBeNull());
	expect(presentationClaims.getSnapshot()).toHaveLength(1);
});

it("keeps the generic fallback when a request is outside the active form", async () => {
	await updateRequest({ reqId: 99, kind: "editor", title: "Unsupported field" });
	await vi.waitFor(() => expect(opens).toHaveLength(1));
	expect(presentationClaims.getSnapshot()).toEqual([]);
});

it.each(["epoch", "form departure"])("does not carry ownership across %s", async change => {
	await act(async () => {
		snapshot = { ...snapshot, epoch: change === "epoch" ? 2 : snapshot.epoch, surfaces: change === "form departure" ? [] : snapshot.surfaces, revision: snapshot.revision + 1, questionMatches: [] };
		for (const listener of hostListeners) listener(tspHostPatch(null, snapshot));
	});
	await vi.waitFor(() => expect(presentationClaims.getSnapshot()).toEqual([]));
});
