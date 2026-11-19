// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import type { ReactNode } from "react";
import type * as UiModule from "../../ui";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import type { TspHostSnapshot, TspSurfaceSnapshot } from "@shared/tsp-host";
import { hookQuestions } from "@shared/tsp/hook-questions";
import { matchQuestions } from "@shared/tsp/question-match";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import type { GuestClient, GuestSnapshot } from "../../collab/lib/client";
import { SessionController, type SessionView } from "../../state/session";
import { controllerFor, useApp } from "../../state/app";
import { useSessionView } from "../../shell/hooks";
import { presentationClaims } from "../../state/tsp/presentation-claims";
import { OverlayWatcher } from "../../features/palette/OverlayWatcher";
import { autoOpened } from "../../features/palette/TerminalSheet";
import { usePendingQuestion } from "./QuestionCard";
import { askSeriesFor } from "./askSeriesStore";
import evidence from "../../../../main/omp/tsp/fixtures/18.18.3/ask-html-form.ask.json";
import "../../i18n";

vi.hoisted(() => {
	// As in ComposerAvailability.test, use Motion's JS fallback for happy-dom's incomplete WAAPI.
	Reflect.deleteProperty(Element.prototype, "animate");
});
vi.mock("../../ui", async importOriginal => {
	const actual = await importOriginal<typeof UiModule>();
	return {
		...actual,
		PresenceSwap: ({ children }: { children: ReactNode }) => children,
	};
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
const first = evidence.stages[0]!.request as Extract<CollabUiRequest, { kind: "select" }>;

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

async function updateFormRequest(html: string, request: CollabUiRequest | null) {
	await act(async () => {
		const activeTools = new Map(view.guest!.activeTools);
		const active = activeTools.get(call.id)!;
		activeTools.set(call.id, { ...active, args: { ...(active.args as Record<string, unknown>), html } });
		view = { ...view, guest: { ...view.guest!, uiRequest: request, pendingUiRequests: request ? [request] : [], activeTools } };
		for (const listener of listeners) listener();
	});
}
async function typeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
	await act(async () => {
		const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
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
	const surfaces = (structuredClone(evidence.stages[0]!.surfaces) as unknown as TspSurfaceSnapshot[]).map(surface => ({ ...surface, documentGeneration: 1 }));
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


it("renders the form series and hides guest key hints", async () => {
	const keyHints = "↑/↓ navigate Enter toggle Next → continue Escape cancel";
	await updateFormRequest(call.arguments.html, { ...first, helpText: keyHints });
	const series = element.querySelector<HTMLElement>('[data-question-card="series"]');
	expect(series?.getAttribute("data-ask-series")).toBe(call.id);
	expect(element.textContent).toContain("Question 1 of 3");
	expect(element.textContent).not.toContain(keyHints);
	expect(element.querySelector("[data-form-question]")).not.toBeNull();
});

it("keeps answers while navigating and restores defaults when skipping a field", async () => {
	const answer = vi.spyOn(controller, "answer").mockImplementation(() => {});
	const card = () => element.querySelector<HTMLElement>('[data-question-card="series"]')!;
	const waitForRole = async (role: "radio" | "checkbox") => vi.waitFor(() => expect(card().querySelector(`[role="${role}"]`)).not.toBeNull());
	const button = (label: string) => [...card().querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label)!;
	const click = async (label: string) => act(async () => button(label).click());

	await act(async () => card().querySelector<HTMLButtonElement>('[data-choice="1"]')!.click());
	expect(card().querySelector('[data-choice="1"]')?.getAttribute("aria-checked")).toBe("true");
	await click("Next question");
	await waitForRole("checkbox");
	expect(card().textContent).toContain("Question 2 of 3");
	await act(async () => card().querySelector<HTMLButtonElement>('[data-choice="1"]')!.click());
	const other = card().querySelector<HTMLInputElement>('input[aria-label="Other (type your own)"]')!;
	await typeValue(other, "Accessibility");
	await click("Next question");
	await vi.waitFor(() => expect(card().textContent).toContain("Question 3 of 3"));
	const note = card().querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
	await typeValue(note, "Reviewed once");

	await click("Previous question");
	await waitForRole("checkbox");
	expect(card().querySelector<HTMLInputElement>('input[aria-label="Other (type your own)"]')?.value).toBe("Accessibility");
	await click("Previous question");
	await waitForRole("radio");
	expect(card().querySelector('[data-choice="1"]')?.getAttribute("aria-checked")).toBe("true");
	await click("Skip this question");
	await waitForRole("checkbox");
	expect(card().textContent).toContain("Question 2 of 3");
	await click("Previous question");
	await waitForRole("radio");
	expect(card().querySelector('[data-choice="0"]')?.getAttribute("aria-checked")).toBe("true");
	expect(card().querySelector('[data-choice="1"]')?.getAttribute("aria-checked")).toBe("false");
	await click("Next question");
	await waitForRole("checkbox");
	expect(card().querySelector<HTMLInputElement>('input[aria-label="Other (type your own)"]')?.value).toBe("Accessibility");
	await click("Next question");
	await vi.waitFor(() => expect(card().textContent).toContain("Question 3 of 3"));
	expect(card().querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.value).toBe("Reviewed once");
	expect(answer).not.toHaveBeenCalled();
});

it("cancels the held form request and ends omp's reply", async () => {
	const answer = vi.spyOn(controller, "answer").mockImplementation(() => {});
	const cancel = [...element.querySelectorAll<HTMLButtonElement>('[data-question-card="series"] button')]
		.find(button => button.textContent?.trim() === "Cancel form and stop reply");
	expect(cancel).not.toBeUndefined();
	await act(async () => cancel!.click());
	expect(answer).toHaveBeenCalledExactlyOnceWith(first.reqId, undefined);
});
it("replays saved form answers in request order", async () => {
	const answer = vi.spyOn(controller, "answer").mockImplementation(() => {});
	const card = () => element.querySelector<HTMLElement>('[data-question-card="series"]')!;
	const waitForRole = async (role: "radio" | "checkbox") => vi.waitFor(() => expect(card().querySelector(`[role="${role}"]`)).not.toBeNull());
	const button = (label: string) => [...card().querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label)!;
	const click = async (label: string) => act(async () => button(label).click());

	await typeValue(card().querySelector<HTMLInputElement>('input[aria-label="Other (type your own)"]')!, "Canary");
	await click("Next question");
	await waitForRole("checkbox");
	await act(async () => card().querySelector<HTMLButtonElement>('[data-choice="1"]')!.click());
	await typeValue(card().querySelector<HTMLInputElement>('input[aria-label="Other (type your own)"]')!, "Accessibility");
	await click("Next question");
	await vi.waitFor(() => expect(card().textContent).toContain("Question 3 of 3"));
	await typeValue(card().querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!, "Reviewed once");
	await click("Send answers");
	await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));

	const stages = evidence.stages.slice(1, 7);
	const replies = ["Canary", "Tests", "Other (type your own)", "Accessibility", "Next →", "Reviewed once"];
	for (const [index, stage] of stages.entries()) {
		await updateRequest(null);
		const request = stage.request as CollabUiRequest;
		await updateRequest(request);
		await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(index + 2));
	}
	const requests = [first, ...stages.map(stage => stage.request as CollabUiRequest)];
	const values = ["Other (type your own)", ...replies];
	for (const [index, request] of requests.entries()) expect(answer).toHaveBeenNthCalledWith(index + 1, request.reqId, values[index]);
});

it("cancels the choice list after cancelling its Other editor", async () => {
	const answer = vi.spyOn(controller, "answer").mockImplementation(() => {});
	const editor: CollabUiRequest = { reqId: 99, kind: "editor", title: first.title, prefill: "" };
	await updateRequest(editor);
	await vi.waitFor(() => expect(element.querySelector('[data-form-question] [data-question-card="99"]')).not.toBeNull());
	const cancel = [...element.querySelectorAll<HTMLButtonElement>('[data-question-card="99"] button')]
		.find(button => button.textContent?.trim() === "Cancel form and stop reply")!;
	await act(async () => cancel.click());
	expect(answer).toHaveBeenCalledExactlyOnceWith(99, undefined);

	await updateRequest({ ...first, reqId: 100 });
	await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
	expect(answer).toHaveBeenNthCalledWith(2, 100, undefined);
});

it("starts fallback at the held field after navigation moves ahead", async () => {
	const html = `<form>
		<fieldset><legend>First flavor</legend><div><p>Held field context</p></div><label><input type="radio" name="first" value="alpha" checked>Alpha</label><label><input type="radio" name="first" value="beta">Beta</label></fieldset>
		<fieldset><legend>Second flavor</legend><div><p>Second field context</p></div><label><input type="radio" name="second" value="alpha">Alpha</label><label><input type="radio" name="second" value="beta" checked>Beta</label></fieldset>
	</form>`;
	const held: CollabUiRequest = { reqId: 120, kind: "select", title: "First flavor", options: ["Alpha", "Beta", "Other (type your own)"], initialIndex: 0, selectionMarker: "radio" };
	await updateFormRequest(html, null);
	await updateFormRequest(html, held);
	const series = () => element.querySelector<HTMLElement>('[data-question-card="series"]')!;
	const next = [...series().querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Next question")!;
	await act(async () => next.click());
	await vi.waitFor(() => expect(series().textContent).toContain("Question 2 of 2"));
	await updateRequest({ ...held, reqId: 121 });
	await vi.waitFor(() => expect(element.querySelector('[data-form-question] [data-question-card="121"]')).not.toBeNull());
	expect(element.textContent).toContain("Held field context");
	expect(element.textContent).not.toContain("Second field context");
});

it("routes a normalized single-line validation re-ask to the field just submitted", async () => {
	const answer = vi.spyOn(controller, "answer").mockImplementation(() => {});
	const html = `<form>
		<fieldset><legend>First note</legend><p>First field context</p><label>Release note<input name="first" value="First default" minlength="4" required></label></fieldset>
		<fieldset><legend>Second note</legend><p>Second field context</p><label>Release note<input name="second" value="Second default" minlength="12" required></label></fieldset>
	</form>`;
	const firstEditor: CollabUiRequest = { reqId: 110, kind: "editor", title: "Release note", prefill: "First default" };
	const secondEditor: CollabUiRequest = { reqId: 111, kind: "editor", title: "Release note", prefill: "Second default" };
	const validation: CollabUiRequest = { reqId: 112, kind: "editor", title: "Release note (too short)", prefill: "Too short" };
	await updateFormRequest(html, null);
	await updateFormRequest(html, firstEditor);
	const driver = askSeriesFor(controller);
	expect(driver.getSnapshot()).toMatchObject({ phase: "editing", questions: [{ question: "Release note" }, { question: "Release note" }] });
	await act(async () => {
		driver.setAnswer(0, { selected: [], custom: "", text: "First note accepted" });
		driver.setAnswer(1, { selected: [], custom: "", text: "Too\nshort" });
		driver.submit();
	});
	await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
	await updateFormRequest(html, null);
	await updateFormRequest(html, secondEditor);
	await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
	await updateFormRequest(html, null);
	expect(driver.getSnapshot()).toMatchObject({ phase: "sent", cursor: { question: 2 } });
	expect(answer).toHaveBeenNthCalledWith(2, 111, "Too\nshort");
	await updateFormRequest(html, validation);
	expect(driver.getSnapshot()).toMatchObject({ toolCallId: call.id, formHtml: html, phase: "fallback", cursor: { question: 2 }, fallbackWhileSending: true });
	await vi.waitFor(() => expect(element.querySelector('[data-form-question] [data-question-card="112"]')).not.toBeNull());
	const fallbackCard = element.querySelector('[data-form-question] [data-question-card="112"]');
	const fallbackForm = fallbackCard?.closest('[data-form-question]');
	expect(fallbackForm?.textContent).toContain("Second field context");
	expect(fallbackForm?.textContent).not.toContain("First field context");
	expect(fallbackForm?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Too short");
	const textarea = fallbackCard!.querySelector<HTMLTextAreaElement>("textarea")!;
	await typeValue(textarea, "Try again\nwith line breaks");
	const send = [...fallbackCard!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Send answer")!;
	await act(async () => send.click());
	expect(answer).toHaveBeenNthCalledWith(3, 112, "Try again\nwith line breaks");
	await updateFormRequest(html, null);
	await updateFormRequest(html, { ...validation, reqId: 113, prefill: "Try again with line breaks" });
	await vi.waitFor(() => expect(element.querySelector('[data-form-question] [data-question-card="113"]')).not.toBeNull());
	const normalizedFallback = element.querySelector('[data-form-question] [data-question-card="113"]');
	const normalizedForm = normalizedFallback?.closest('[data-form-question]');
	expect(normalizedForm?.textContent).toContain("Second field context");
	expect(normalizedForm?.textContent).not.toContain("First field context");
	expect(normalizedForm?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Try again with line breaks");
	const skip = [...normalizedFallback!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Skip this question")!;
	expect(skip.disabled).toBe(false);
	await act(async () => skip.click());
	expect(answer).toHaveBeenNthCalledWith(4, 113, "Second default");
	expect(answer).toHaveBeenCalledTimes(4);
});

it("uses the live form fallback and hides guest key hints", async () => {
	const keyHints = "↑/↓ navigate Enter toggle Next → continue Escape cancel";
	const fallback = { ...first, reqId: 99, helpText: keyHints };
	await updateRequest(fallback);
	await vi.waitFor(() => expect(element.querySelector('[data-form-question] [data-question-card="99"]')).not.toBeNull());
	expect(element.textContent).toContain("Cancel form and stop reply");
	expect(element.textContent).toContain("Skip this question");
	expect(element.textContent).not.toContain(keyHints);
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
	const seriesCard = element.querySelector('[data-question-card="series"]');
	expect(seriesCard).not.toBeNull();
	await act(async () => {
		const result = entries.find(entry => entry.message?.role === "toolResult");
		view = { ...view, working: false, guest: { ...view.guest!, uiRequest: null, pendingUiRequests: [], activeTools: new Map(), entries: [result], working: false } };
		snapshot = { ...snapshot, revision: snapshot.revision + 1, questionMatches: snapshot.questionMatches?.map(match => ({ ...match, status: "settling" })) };
		for (const listener of listeners) listener();
		for (const listener of hostListeners) listener(tspHostPatch(null, snapshot));
	});
	await vi.waitFor(() => expect(element.querySelector("[data-form-status-text]")?.textContent).toBe("Closing omp's question."));
	expect(element.querySelector('[data-question-card="series"]')).toBe(seriesCard);
	expect(element.querySelector("[data-form-question]")).not.toBeNull();
	expect(element.querySelector("[data-question-card]")).not.toBeNull();
	expect(presentationClaims.getSnapshot()).toHaveLength(1);
	expect(opens).toEqual([]);
	await act(async () => {
		snapshot = { ...snapshot, revision: snapshot.revision + 1, questionMatches: [], surfaces: [] };
		for (const listener of hostListeners) listener(tspHostPatch(null, snapshot));
	});
	await vi.waitFor(() => expect(element.querySelector("[data-form-question]")).toBeNull());
	expect(element.querySelector('[data-question-card="series"]')).toBeNull();
	expect(presentationClaims.getSnapshot()).toEqual([]);
	expect(opens).toEqual([]);
});
