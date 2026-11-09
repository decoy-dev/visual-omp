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

vi.hoisted(() => {
	// As in ComposerAvailability.test, use Motion's JS fallback for happy-dom's incomplete WAAPI.
	Reflect.deleteProperty(Element.prototype, "animate");
});

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
const radio = evidence.stages[0]!.request as Extract<CollabUiRequest, { kind: "select" }>;
const editor = evidence.stages[6]!.request as Extract<CollabUiRequest, { kind: "editor" }>;

function Harness() {
	const current = useSessionView(controller);
	const pending = usePendingQuestion(controller, current?.guest?.uiRequest ?? null);
	return createElement(Fragment, null, createElement(OverlayWatcher), pending && createElement("div", { key: pending.key, "data-in-place": pending.inPlace }, pending.node));
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

it("marks only the stable form presenter as an in-place question", async () => {
	expect(element.querySelector('[data-in-place="true"] [data-form-question]')).not.toBeNull();
	await updateRequest(null);
	expect(element.querySelector('[data-in-place="true"] [data-form-question]')).not.toBeNull();
	await updateRequest({ reqId: 99, kind: "editor", title: "Unsupported field" });
	expect(element.querySelector("[data-in-place]")).toBeNull();
});

it("restores a checkbox blurred by retirement without scrolling or taking focus from another control", async () => {
	const option = element.querySelector<HTMLButtonElement>('[data-choice="1"]')!;
	option.focus();
	await updateRequest(null);
	// Browsers can clear focus when the fieldset disables; happy-dom keeps its old activeElement.
	const active = vi.spyOn(document, "activeElement", "get").mockReturnValue(document.body);
	const focus = vi.spyOn(option, "focus");
	await updateRequest(next);
	active.mockRestore();
	expect(document.activeElement).toBe(option);
	expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
	await updateRequest(null);
	const external = document.createElement("button");
	element.append(external);
	external.focus();
	await updateRequest({ ...next, reqId: 105 });
	expect(document.activeElement).toBe(external);
	expect(focus).toHaveBeenCalledTimes(1);
});

it("keeps the same checkbox card, option nodes and focus when only the request and checked values change", async () => {
	const card = element.querySelector("[data-question-card]");
	const options = [...element.querySelectorAll<HTMLButtonElement>("[data-choice]")];
	const answer = vi.spyOn(controller, "answer").mockImplementation(() => {});
	options[1]!.focus();
	await act(async () => options[1]!.click());
	expect(answer).toHaveBeenCalledExactlyOnceWith(first.reqId, "Tests");
	await updateRequest(next);
	expect(element.querySelector("[data-question-card]")).toBe(card);
	expect([...element.querySelectorAll("[data-choice]")]).toEqual(options);
	expect(document.activeElement).toBe(options[1]);
	expect(options[1]!.getAttribute("aria-checked")).toBe("true");
	await act(async () => options[0]!.click());
	expect(answer).toHaveBeenLastCalledWith(next.reqId, "Types");
});

it("keeps one in-card status slot and disables option actions throughout request retirement", async () => {
	const card = element.querySelector("[data-question-card]");
	const status = card!.querySelector('[role="status"]');
	const options = [...element.querySelectorAll<HTMLButtonElement>("[data-choice]")];
	const answer = vi.spyOn(controller, "answer").mockImplementation(() => {});
	expect(status?.querySelector("[data-form-status-text]")?.textContent).toBe("Sending a message closes this question without stopping the reply.");
	await updateRequest(null);
	expect(element.querySelector("[data-question-card]")).toBe(card);
	expect(element.querySelectorAll('[role="status"]')).toHaveLength(1);
	expect(card!.querySelector('[role="status"]')).toBe(status);
	expect(status?.querySelector("[data-form-status-text]")?.textContent).toBe("Waiting for the next question from omp.");
	expect(options.every(option => option.disabled)).toBe(true);
	await act(async () => {
		options[1]!.click();
		options[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
	});
	expect(answer).not.toHaveBeenCalled();
	await updateRequest(next);
	expect(element.querySelector('[role="status"]')).toBe(status);
	expect([...element.querySelectorAll("[data-choice]")]).toEqual(options);
	expect(options.every(option => !option.disabled)).toBe(true);
	expect(status?.querySelector("[data-form-status-text]")?.textContent).toBe("Sending a message closes this question without stopping the reply.");
	expect(status?.querySelector("[aria-hidden]")?.textContent).toBe("Sending a message closes this question without stopping the reply.");
});

it("resets local radio selection for a replacement request without remounting its options", async () => {
	await updateRequest(radio);
	const options = [...element.querySelectorAll<HTMLButtonElement>("[data-choice]")];
	const answer = vi.spyOn(controller, "answer").mockImplementation(() => {});
	await act(async () => options[1]!.click());
	expect(options[1]!.getAttribute("aria-checked")).toBe("true");
	expect(answer).not.toHaveBeenCalled();
	await updateRequest({ ...radio, reqId: 101, initialIndex: 0 });
	expect([...element.querySelectorAll("[data-choice]")]).toEqual(options);
	expect(options[0]!.getAttribute("aria-checked")).toBe("true");
	expect(options[1]!.getAttribute("aria-checked")).toBe("false");
	await act(async () => element.querySelector<HTMLButtonElement>("[data-question-card] > div:last-child button:last-child")!.click());
	expect(answer).toHaveBeenCalledExactlyOnceWith(101, "Stable");
	await updateRequest(next);
	expect(element.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
});

it("moves radio focus without scrolling and ignores keyboard selection while the form waits", async () => {
	await updateRequest(radio);
	const options = [...element.querySelectorAll<HTMLButtonElement>("[data-choice]")];
	const focus = vi.spyOn(options[1]!, "focus");
	options[0]!.focus();
	await act(async () => options[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
	expect(document.activeElement).toBe(options[1]);
	expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
	expect(options[1]!.getAttribute("aria-checked")).toBe("true");
	await updateRequest(null);
	await act(async () => options[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
	expect(options[1]!.getAttribute("aria-checked")).toBe("true");
});

it("resets editor text on replacement and focuses the persistent textarea without scrolling", async () => {
	const focus = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
	await updateRequest(editor);
	const textarea = element.querySelector("textarea")!;
	expect(textarea.value).toBe("Keep compatibility");
	expect(textarea.hasAttribute("autofocus")).toBe(false);
	expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "My local answer");
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const answer = vi.spyOn(controller, "answer").mockImplementation(() => {});
	await act(async () => element.querySelector<HTMLButtonElement>("[data-question-card] > div:last-child button:last-child")!.click());
	expect(answer).toHaveBeenCalledExactlyOnceWith(editor.reqId, "My local answer");
	await updateRequest(null);
	expect(textarea.disabled).toBe(true);
	expect(element.querySelector("textarea")).toBe(textarea);
	await updateRequest({ ...editor, reqId: 102, prefill: "New prefill" });
	expect(element.querySelector("textarea")).toBe(textarea);
	expect(textarea.value).toBe("New prefill");
	expect(document.activeElement).toBe(textarea);
	expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
	await updateRequest(radio);
	await updateRequest({ ...editor, reqId: 103, prefill: undefined });
	expect(element.querySelector("textarea")!.value).toBe("");
});

it("retains the actual card height and full form area until the form ends", async () => {
	let width = 760;
	let height = 300;
	let area = 340;
	vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLDivElement) { return new DOMRect(0, 0, width, this.hasAttribute("data-form-question") ? area : 0); });
	vi.spyOn(HTMLFieldSetElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, height));
	await updateRequest(next);
	const form = element.querySelector<HTMLElement>("[data-form-question]")!;
	const card = () => element.querySelector<HTMLElement>("[data-question-card]")!;
	expect(card().style.minHeight).toBe("300px");
	expect(form.style.minHeight).toBe("340px");
	height = 200;
	area = 200;
	await updateRequest(editor);
	expect(card().style.minHeight).toBe("300px");
	expect(form.style.minHeight).toBe("340px");
	await updateRequest(null);
	expect(card().style.minHeight).toBe("300px");
	width = 600;
	await updateRequest({ ...editor, reqId: 104 });
	expect(card().style.minHeight).toBe("300px");
	height = 360;
	area = 400;
	await updateRequest({ ...editor, reqId: 105 });
	expect(card().style.minHeight).toBe("360px");
	expect(form.style.minHeight).toBe("400px");
	expect(form.isConnected).toBe(true);
});

it("offers an explicit screen action for uncertain matching and recovers without opening it", async () => {
	const matched = snapshot.questionMatches;
	await publishMatches(matched?.map(match => ({ ...match, status: "ambiguous", reqId: undefined })));
	await vi.waitFor(() => expect(element.querySelector("[data-form-fallback] button")).not.toBeNull());
	expect(opens).toEqual([]);
	expect(presentationClaims.getSnapshot()).toEqual([]);
	await act(async () => (element.querySelector("[data-form-fallback] button") as HTMLButtonElement).click());
	expect(opens).toHaveLength(1);
	await publishMatches(matched);
	expect(useApp.getState().terminalTabId).toBe(tabId);
	await act(async () => useApp.getState().closeTerminal());
	await vi.waitFor(() => expect(presentationClaims.getSnapshot()).toHaveLength(1));
});

it("keeps unsupported requests in the chat and opens the screen only on request", async () => {
	await updateRequest({ reqId: 99, kind: "editor", title: "Unsupported field" });
	await vi.waitFor(() => expect(element.querySelector("[data-form-fallback] button")).not.toBeNull());
	expect(element.textContent).toContain("Unsupported field");
	expect(opens).toEqual([]);
	expect(presentationClaims.getSnapshot()).toEqual([]);
	await act(async () => (element.querySelector("[data-form-fallback] button") as HTMLButtonElement).click());
	expect(opens).toHaveLength(1);
});

it.each(["epoch", "form departure"])("does not carry ownership across %s", async change => {
	await act(async () => {
		snapshot = { ...snapshot, epoch: change === "epoch" ? 2 : snapshot.epoch, surfaces: change === "form departure" ? [] : snapshot.surfaces, revision: snapshot.revision + 1, questionMatches: [] };
		for (const listener of hostListeners) listener(tspHostPatch(null, snapshot));
	});
	await vi.waitFor(() => expect(presentationClaims.getSnapshot()).toEqual([]));
});

it("keeps a native-only question visible with a manual screen action", async () => {
	await act(async () => {
		view = { ...view, guest: { ...view.guest!, uiRequest: null, activeTools: new Map(), working: false } };
		for (const listener of listeners) listener();
	});
	await vi.waitFor(() => expect(element.textContent).toContain("Question from omp"));
	expect(element.textContent).toContain("View this question in the omp screen to answer it.");
	expect(opens).toEqual([]);
});

it("holds the completed form presentation until its native node departs", async () => {
	const card = element.querySelector("[data-question-card]");
	const status = element.querySelector('[role="status"]');
	await act(async () => {
		const result = entries.find(entry => entry.message?.role === "toolResult");
		view = { ...view, working: false, guest: { ...view.guest!, uiRequest: null, pendingUiRequests: [], activeTools: new Map(), entries: [result], working: false } };
		snapshot = { ...snapshot, revision: snapshot.revision + 1, questionMatches: snapshot.questionMatches?.map(match => ({ ...match, status: "settling" })) };
		for (const listener of listeners) listener();
		for (const listener of hostListeners) listener(tspHostPatch(null, snapshot));
	});
	await vi.waitFor(() => expect(element.textContent).toContain("Closing omp's question."));
	expect(element.querySelector("[data-question-card]")).toBe(card);
	expect(element.querySelector('[role="status"]')).toBe(status);
	expect(presentationClaims.getSnapshot()).toHaveLength(1);
	expect(opens).toEqual([]);
	await act(async () => {
		snapshot = { ...snapshot, revision: snapshot.revision + 1, questionMatches: [], surfaces: [] };
		for (const listener of hostListeners) listener(tspHostPatch(null, snapshot));
	});
	await vi.waitFor(() => expect(element.querySelector("[data-form-question]")).toBeNull());
	expect(opens).toEqual([]);
});
