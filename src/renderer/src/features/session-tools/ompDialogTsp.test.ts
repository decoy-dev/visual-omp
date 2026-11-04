// @vitest-environment happy-dom
import { act, createElement, Fragment, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hookAnswerEvents, hookDialogTarget } from "@shared/tsp/dialogs";
import { hookQuestions } from "@shared/tsp/question-match";
import { QuestionArbitrator } from "@shared/tsp/question-arbitrator";
import { openOverlay, unclaimed } from "@shared/tsp/view-state";
import type { TspHookAnswer } from "@shared/tsp/dialogs";
import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { FixtureDocuments, loadFixtureRecording } from "../tsp/testing/documents";
import { OmpDialogCard } from "./OmpDialogCard";
import { currentHook, nativeDialog, waitForNodeToLeave } from "./ompDialogTsp";
import { parseOmpDialog } from "./ompDialog";
import type { SessionController, SessionView } from "../../state/session";
import "../../i18n";
import { PresentationVisibility, presentationClaims } from "../../state/tsp/presentation-claims";
import { OmpScreenSheet } from "../tsp/OmpScreenSheet";

vi.mock("motion/react", () => {
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, variants, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { AnimatePresence: ({ children }: PropsWithChildren) => children, MotionConfig: ({ children }: PropsWithChildren) => children, motion: { div: tag("div"), section: tag("section"), span: tag("span"), ul: tag("ul"), li: tag("li") }, useReducedMotionConfig: () => true };
});
const classics = import.meta.glob<string>("./fixtures/omp-dialogs/*.txt", { query: "?raw", import: "default", eager: true });
const parity = Object.entries(classics).filter(([, text]) => parseOmpDialog(text.split("\n"))).map(([path]) => path.split("/").at(-1)!.replace(".txt", ""));
let root: Root;
let element: HTMLDivElement;
let listeners: Set<(patch: TspHostPatch) => void>;
let snapshot: TspHostSnapshot;
let invoke: ReturnType<typeof vi.fn>;
let session: SessionController;
let emitted: TspRendererEvent[];
let complete: (() => void) | null;
const scope = { hostId: "fixture", generation: 1, epoch: 1 };
const view = { mode: "live", readOnly: false, host: { hostId: "fixture", transport: "tsp", generation: 1 } } as unknown as SessionView;
function publish(next: TspHostSnapshot) { snapshot = next; for (const listener of listeners) listener(tspHostPatch(null, next)); }
function capture(name: string) {
	const recording = loadFixtureRecording(name);
	const events = recording.inputs.filter(input => "body" in input && ["activate", "edit", "action"].includes(input.body.ev));
	const edit = events.findLastIndex(input => "body" in input && input.body.ev === "edit");
	const expected = name.endsWith("cancel") ? events.slice(-1) : edit >= 0 ? events.slice(edit) : events;
	const documents = new FixtureDocuments();
	const boundary = expected[0]?.afterMessage ?? recording.messages.findIndex(message => message.verb === "x");
	for (const message of recording.messages.slice(0, boundary)) documents.receive({ ...message, body: JSON.stringify(message.body) });
	const arb = new QuestionArbitrator();
	arb.update(scope, { ...scope, connection: 1, revision: 1, connected: true, requests: [] });
	const snap = (): TspHostSnapshot => structuredClone({ ...documents.snapshot(), ...scope, revision: (snapshot?.revision ?? 0) + 1, lifecycle: "live", documentGeneration: 1, failure: null, availability: { available: false, reason: "Question open" }, questionMatches: arb.matches(scope, hookQuestions(documents.snapshot().surfaces, 1)), surfaces: documents.snapshot().surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) });
	snapshot = snap();
	complete = () => { for (const message of recording.messages.slice(boundary)) documents.receive({ ...message, body: JSON.stringify(message.body) }); publish(snap()); };
	return { recording, expected, documents, arb, snap };
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	listeners = new Set(); emitted = []; complete = null;
	invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
		if (channel === "host:tsp-snapshot") return snapshot;
		if (channel === "host:tsp-answer") {
			const answer = args[2] as TspHookAnswer;
			const target = hookDialogTarget(snapshot.surfaces)!;
			emitted.push(...hookAnswerEvents(target.node, answer));
		}
	});
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke, on: (channel: string, listener: (patch: TspHostPatch) => void) => { if (channel === "host:tsp-patch") listeners.add(listener); return () => listeners.delete(listener); } } });
	session = { hostId: "fixture", getSnapshot: () => view, subscribe: () => () => {} } as unknown as SessionController;
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); Reflect.deleteProperty(window, "vomp"); });
async function render() { await act(async () => root.render(createElement(OmpDialogCard, { session }))); }
async function button(label: string) { const button = [...element.querySelectorAll("button")].find(button => button.textContent === label); expect(button, label).toBeDefined(); await act(async () => button!.click()); }
async function fill(value: string) {
	const field = element.querySelector("input,textarea")!;
	await act(async () => { Object.getOwnPropertyDescriptor(field.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
}

it.each(["hook-select", "hook-confirm", "hook-input", "hook-editor", "hook-select-cancel", "hook-confirm-cancel", "hook-input-cancel", "hook-editor-cancel", ...parity.map(name => `hook-parity-${name}`)])("completes %s from the native card using exactly the recorded answer", async name => {
	const { expected } = capture(name);
	const target = hookDialogTarget(snapshot.surfaces)!;
	const dialog = nativeDialog(target.dialog);
	await render();
	expect(element.textContent).toContain(dialog.title);
	expect(element.querySelector("section")).not.toBeNull();
	const owned = new Set(presentationClaims.getSnapshot().filter(claim => claim.hostId === snapshot.hostId && claim.epoch === snapshot.epoch && claim.surfaceId === target.surface.open.id).map(claim => claim.nodeId));
	expect(owned.has(target.node.id)).toBe(true);
	for (const surface of snapshot.surfaces) expect([...unclaimed(surface, "layer", owned), ...unclaimed(surface, "dock", owned)].some(node => node.id === target.node.id)).toBe(false);
	expect(openOverlay(snapshot.surfaces, false, new Map([[target.surface.open.id, owned]]))).toBeNull();
	expect(openOverlay(snapshot.surfaces, true)?.node.id).toBe(target.node.id);
	const first = expected[0]!;
	if (!("body" in first)) throw new Error("Expected semantic answer");
	if (name.endsWith("cancel")) {
		// Confirm's No button is an answer; its Escape is cancellation.
		if (dialog.kind === "select" && dialog.confirm) await act(async () => element.querySelector("section")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		else await button("Cancel");
	} else if (first.body.ev === "activate") {
		if (target.dialog.body.kind !== "select") throw new Error("Expected choices");
		const item = first.body.item;
		const index = target.dialog.body.options.findIndex(option => option.id === item);
		if (dialog.kind === "select" && dialog.confirm) await button(target.dialog.body.options[index]!.label);
		else { await act(async () => element.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]!.click()); await button("Choose option"); }
	} else if (first.body.ev === "edit") { await fill(first.body.text); await button("Send answer"); }
	expect(emitted).toEqual(expected.map(input => "body" in input ? input.body : input));
	expect(invoke.mock.calls.filter(call => call[0] === "host:tsp-answer")).toHaveLength(1);
	expect(invoke.mock.calls.some(call => ["host:screen", "host:keys", "host:tsp-event"].includes(String(call[0])))).toBe(false);
	expect(element.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
	expect([...element.querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled)).toBe(true);
	await act(async () => complete!());
	expect(element.querySelector("section")).toBeNull();
});

it.each(parity)("preserves classic %s card content with a recorded semantic counterpart", name => {
	const classic = parseOmpDialog(classics[`./fixtures/omp-dialogs/${name}.txt`]!.split("\n"))!;
	capture(`hook-parity-${name}`);
	const target = hookDialogTarget(snapshot.surfaces)!;
	const native = nativeDialog(target.dialog);
	expect(native.kind).toBe(classic.kind); expect(native.title).toBe(classic.title); expect(native.detail).toEqual(classic.detail);
	if (native.kind === "select" && classic.kind === "select") {
		expect(native.options.map(({ label, description }) => ({ label, description }))).toEqual(classic.hidden ? Array.from({ length: 20 }, (_, index) => ({ label: `Region ${index + 1}`, description: null })) : classic.options);
		expect(native.hidden).toBe(0); expect(native.query).toBeNull();
	} else if (native.kind !== "select" && classic.kind !== "select") expect(native.value).toBe(classic.value);
});

it("renders every option of a long list without the hidden-options note or terminal offer", async () => {
	capture("hook-parity-selector-windowed"); await render();
	expect(element.querySelectorAll('[role="radio"]')).toHaveLength(20);
	expect(element.textContent).toContain("Region 20"); expect(element.textContent).not.toMatch(/options hidden|Open terminal/);
});
it.each(["ambiguous", "unavailable", "settling", "answering", "closing"] as const)("keeps the native card display-only while %s", async status => {
	capture("hook-select"); snapshot = { ...snapshot, closing: status === "closing", questionMatches: snapshot.questionMatches!.map(match => ({ ...match, status: status === "closing" ? "unmatched" : status })) }; await render();
	expect(element.querySelector("section")).not.toBeNull(); expect([...element.querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled)).toBe(true);
	await act(async () => element.querySelector("section")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	expect(emitted).toEqual([]);
});
it("removes the native card when a delayed collab request matches and after a remote guest answer", async () => {
	const { arb, snap } = capture("hook-collab-aware"); await render(); expect(element.querySelector("section")).not.toBeNull();
	const question = hookQuestions(snapshot.surfaces, 1)[0]!;
	arb.update(scope, { ...scope, connection: 1, revision: 2, connected: true, requests: [{ reqId: 4, kind: "select", title: question.title, options: question.options! }] });
	await act(async () => publish(snap())); expect(element.querySelector("section")).toBeNull();
	arb.update(scope, { ...scope, connection: 2, revision: 3, connected: false, requests: [] });
	await act(async () => publish(snap())); expect([...element.querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled)).toBe(true);
	await act(async () => publish({ ...snapshot, revision: snapshot.revision + 1, surfaces: [] })); expect(element.querySelector("section")).toBeNull(); expect(emitted).toEqual([]);
});
it("shows calm completion for a losing local answer whose node has already gone", async () => {
	capture("hook-select"); invoke.mockImplementation(async (channel: string) => { if (channel === "host:tsp-snapshot") return snapshot; if (channel === "host:tsp-answer") throw new Error("omp screen: The question node is no longer available."); });
	await render(); await button("Choose option"); expect(element.querySelector('[role="alert"]')).toBeNull(); expect(element.querySelector('[role="status"]')?.textContent).toContain("closed");
});
it("waits for node departure without polling and ends on scope changes", async () => {
	capture("hook-input"); let current = snapshot; const watchers = new Set<() => void>();
	const source = { getSnapshot: () => current, subscribe: (listener: () => void) => { watchers.add(listener); return () => { watchers.delete(listener); }; } };
	const update = (next: TspHostSnapshot) => { current = next; for (const listener of watchers) listener(); };
	const target = hookDialogTarget(snapshot.surfaces)!; const settled = vi.fn();
	const waiting = waitForNodeToLeave(source, snapshot, target.surface.open.id, target.node.id).then(settled);
	update({ ...snapshot, revision: snapshot.revision + 1 }); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
	update({ ...snapshot, revision: snapshot.revision + 2, epoch: 2 }); await waiting; expect(settled).toHaveBeenCalledOnce();
	expect(currentHook(snapshot, "other", 1)).toBeNull(); expect(currentHook(snapshot, "fixture", 2)).toBeNull();
});
it("keeps custom extension rows unclaimed for the semantic fallback", () => {
	capture("extension-rows-open"); expect(hookDialogTarget(snapshot.surfaces)).toBeNull(); expect(snapshot.surfaces.flatMap(surface => unclaimed(surface, "dock")).length).toBeGreaterThan(0);
});

it("keeps startup hooks visible and display-only before the first question mirror", async () => {
	capture("hook-input");
	snapshot = { ...snapshot, generation: 0, documentGeneration: 0, surfaces: snapshot.surfaces.map(surface => ({ ...surface, documentGeneration: 0 })), questionMatches: snapshot.questionMatches!.map(match => ({ ...match, status: "unavailable" })) };
	const startup = { ...view, mode: "starting", host: { ...view.host!, generation: 0 } } as SessionView;
	session = { ...session, getSnapshot: () => startup } as unknown as SessionController;
	await render();
	expect(element.textContent).toContain("Enter a fixture value");
	expect(element.querySelector("input")?.disabled).toBe(true);
	expect([...element.querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled)).toBe(true);
	await act(async () => element.querySelector("section")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	expect(invoke.mock.calls.some(call => ["host:keys", "host:tsp-answer", "host:screen"].includes(String(call[0])))).toBe(false);
});

it("restores the generic hook when the card is absent, a page covers the chat, its split pane is hidden or it unmounts", async () => {
	capture("hook-select");
	const draw = async (mounted: boolean, chatVisible = true, paneVisible = true) => {
		await act(async () => root.render(createElement(Fragment, null,
			createElement(PresentationVisibility, { visible: chatVisible },
				createElement(PresentationVisibility, { visible: paneVisible }, mounted ? createElement(OmpDialogCard, { session }) : null)),
			createElement(OmpScreenSheet, { hostId: snapshot.hostId, generation: snapshot.generation, snapshot, failed: false, readOnly: false }),
		)));
	};
	const genericOptions = () => element.querySelectorAll(".tsp-screen [role=option]").length;
	await draw(false); expect(genericOptions()).toBe(4);
	await draw(true); expect(genericOptions()).toBe(0);
	expect(presentationClaims.getSnapshot()).toHaveLength(1);
	await draw(true, false); expect(genericOptions()).toBe(4); expect(presentationClaims.getSnapshot()).toHaveLength(0);
	await draw(true, true, false); expect(genericOptions()).toBe(4); expect(presentationClaims.getSnapshot()).toHaveLength(0);
	await draw(true); expect(genericOptions()).toBe(0);
	await draw(false); expect(genericOptions()).toBe(4); expect(presentationClaims.getSnapshot()).toHaveLength(0);
	expect(emitted).toEqual([]);
});

it("does not hide a generic hook for a claim from another host, epoch, surface or node", async () => {
	capture("hook-select");
	const target = hookDialogTarget(snapshot.surfaces)!;
	const exact = { hostId: snapshot.hostId, epoch: snapshot.epoch, surfaceId: target.surface.open.id, nodeId: target.node.id };
	for (const wrong of [{ ...exact, hostId: "another" }, { ...exact, epoch: exact.epoch + 1 }, { ...exact, surfaceId: "other" }, { ...exact, nodeId: "other" }]) {
		const release = presentationClaims.acquire(wrong);
		try {
			await act(async () => root.render(createElement(OmpScreenSheet, { hostId: snapshot.hostId, generation: snapshot.generation, snapshot, failed: false, readOnly: false })));
			expect(element.querySelectorAll(".tsp-screen [role=option]")).toHaveLength(4);
		} finally { await act(async () => release()); }
	}
});

it("preserves disabled native options for pointer, double-click and keyboard navigation", async () => {
	capture("hook-select");
	const picker = hookDialogTarget(snapshot.surfaces)!.node;
	if (picker.k !== "picker") throw new Error("Expected recorded picker");
	picker.p = { ...picker.p, items: picker.p!.items!.map((item, index) => index === 1 ? { ...item, disabled: "Unavailable" } : item) };
	await render();
	const radios = element.querySelectorAll<HTMLButtonElement>('[role="radio"]');
	expect(radios[1]!.disabled).toBe(true);
	await act(async () => { radios[1]!.click(); radios[1]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
	expect(radios[0]!.getAttribute("aria-checked")).toBe("true"); expect(emitted).toEqual([]);
	await act(async () => radios[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
	expect(radios[2]!.getAttribute("aria-checked")).toBe("true"); expect(document.activeElement).toBe(radios[2]);
	await act(async () => radios[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
	expect(radios[0]!.getAttribute("aria-checked")).toBe("true"); expect(emitted).toEqual([]);
});
