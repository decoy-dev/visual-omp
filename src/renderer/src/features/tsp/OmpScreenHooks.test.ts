// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TspDocument } from "../../../../main/omp/tsp/apply";
import { hookAnswerEvents } from "@shared/tsp/dialogs";
import type { TspFrame } from "@shared/tsp";
import { hookQuestions, QuestionArbitrator } from "@shared/tsp/question-match";
import { walkNodes } from "@shared/tsp/view-state";
import type { TspHostSnapshot, TspRendererEvent, TspSurfaceSnapshot } from "@shared/tsp-host";
import { NodeView } from "./nodes/NodeView";
import type { NodeContext } from "./nodes/context";
import "../../i18n";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import type { SessionController } from "../../state/session";
import { QuestionCard } from "../../chat/transcript/QuestionCard";
import { OmpScreenSheet } from "./OmpScreenSheet";

// Chrome covers layout and motion. DOM replay keeps motion tags synchronous,
// following the other renderer DOM tests rather than starting cancellable WAAPI animations.
vi.mock("motion/react", () => {
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { AnimatePresence: ({ children }: PropsWithChildren) => children, MotionConfig: ({ children }: PropsWithChildren) => children, motion: { div: tag("div"), span: tag("span"), ul: tag("ul"), li: tag("li") }, useReducedMotionConfig: () => true };
});

const fixtures = import.meta.glob<string>("../../../../main/omp/tsp/fixtures/18.15.0/*.jsonl", { query: "?raw", import: "default", eager: true });

let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin" } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); Reflect.deleteProperty(window, "vomp"); });

it.each(["hook-select", "hook-confirm", "hook-input", "hook-editor", "hook-select-cancel", "hook-confirm-cancel", "hook-input-cancel", "hook-editor-cancel", "hook-select-open", "hook-confirm-open", "hook-input-open", "hook-editor-open"])("completes recorded %s through the omp screen with the accepted native events", async name => {
	const prefix = "../../../../main/omp/tsp/fixtures/18.15.0/";
	// Open-only captures use the next accepted event and response from their submit recording.
	const completion = name.replace(/-open$/, "");
	const responses: { verb: string; body: unknown }[] = fixtures[`${prefix}${completion}.messages.jsonl`]!.trim().split("\n").map(line => JSON.parse(line));
	const messages: { verb: string; body: unknown }[] = fixtures[`${prefix}${name}.messages.jsonl`]!.trim().split("\n").map(line => JSON.parse(line));
	const recorded: { verb: string; body: TspRendererEvent; afterMessage: number }[] = fixtures[`${prefix}${completion}.events.jsonl`]!.trim().split("\n").map(line => JSON.parse(line));
	const candidates = recorded.filter(record => record.verb === "e" && ["activate", "edit", "action"].includes(record.body.ev));
	const edit = candidates.findLastIndex(record => record.body.ev === "edit");
	const expected = name.endsWith("cancel") ? candidates.slice(-1) : edit >= 0 ? candidates.slice(edit) : candidates;
	const emitted: TspRendererEvent[] = [];
	const document = new TspDocument("s:1");
	// Frame counts are recording-local. Open-only input can emit its seed in a later frame.
	const beforeInput = name.endsWith("-open") ? messages.slice(0, messages.findIndex(message => message.verb === "x")) : messages.slice(0, expected[0]!.afterMessage);
	for (const message of beforeInput) if (message.verb === "f") document.applyFrame(message.body as TspFrame);
	const surface: TspSurfaceSnapshot = { open: { id: "s:1", mode: "inline" }, document: document.snapshot(), sequence: 1, closed: false, suspended: false, focus: document.focus, settled: [] };
	const scope = { hostId: "fixture", generation: 1, epoch: 1 };
	const arb = new QuestionArbitrator(); arb.update(scope, { ...scope, connection: 1, revision: 1, connected: true, requests: [] });
	const dialogs = hookQuestions([surface], 1);
	const dialog = dialogs[0]!;
	const hook = [...walkNodes(surface.document)].find(node => node.id === dialog.nodeId)!;
	const context: NodeContext = {
		sf: dialog.surfaceId, readOnly: false, questionMatches: arb.matches(scope, dialogs), send: vi.fn(), keys: vi.fn(),
		answer: async answer => {
			const events = hookAnswerEvents(hook, answer);
			arb.answer(scope, hookQuestions([surface], 1), answer.sf, answer.id);
			emitted.push(...events);
		},
		render: node => createElement(NodeView, { node, context }),
	};
	await act(async () => root.render(createElement(NodeView, { node: hook, context })));
	expect(element.querySelector("pre")).toBeNull();
	expect(element.textContent).not.toMatch(/"(?:gap|role|actions|click)"\s*:/);
	expect(element.textContent).not.toContain("{");
	if (name.startsWith("hook-input")) {
		expect(element.textContent).not.toContain(">");
		expect(element.querySelector("input")?.getAttribute("aria-label")).toBe("omp input");
	}
	if (name.endsWith("cancel")) {
		const target = expected[0]!.body;
		if (target.ev !== "action") throw new Error("Expected a recorded cancel action");
		const label = hook.k === "picker" ? hook.p?.actions?.find(action => action.id === target.act)?.label : "Cancel";
		const cancel = hook.k === "picker" ? [...element.querySelectorAll("button")].find(button => button.textContent === label)! : element.querySelector(`[data-tsp-id="${target.id}"] > button`) as HTMLButtonElement;
		expect(cancel).toBeDefined(); await act(async () => cancel.click());
	} else if (expected[0]!.body.ev === "activate") {
		const target = expected[0]!.body;
		if (target.ev !== "activate") throw new Error("Expected a recorded choice activation");
		const picker = [...walkNodes(hook)].find(node => node.k === "picker")!;
		const index = picker.k === "picker" ? picker.p!.items!.findIndex(item => item.id === target.item) : -1;
		await act(async () => element.querySelectorAll('[role="option"]')[index]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await act(async () => element.querySelector('[role="listbox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
	} else {
		const target = expected[0]!.body;
		if (target.ev !== "edit") throw new Error("Expected a recorded text edit");
		const field = element.querySelector("input,textarea") as HTMLInputElement | HTMLTextAreaElement;
		expect(field).toBeTruthy(); expect(field.readOnly).toBe(false);
		await act(async () => {
			const prototype = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, target.text);
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const submitEvent = expected.find(record => record.body.ev === "action")!.body;
		if (submitEvent.ev !== "action") throw new Error("Expected a recorded submit action");
		const submit = element.querySelector(`[data-tsp-id="${submitEvent.id}"] > button`) as HTMLButtonElement;
		await act(async () => submit.click());
	}
	expect(emitted).toEqual(expected.map(record => record.body));
	expect(element.textContent).toContain("Answering");
	expect(context.send).not.toHaveBeenCalled(); expect(context.keys).not.toHaveBeenCalled();
	for (const message of responses.slice(expected[0]!.afterMessage)) {
		if (message.verb === "f") document.applyFrame(message.body as TspFrame);
		if (message.verb === "x") surface.closed = true;
	}
	surface.document = document.snapshot();
	expect(hookQuestions([surface], 1)).toEqual([]);
});

it.each(["matched", "ambiguous"] as const)("keeps the collab question card answerable while the recorded %s hook screen is display-only", async status => {
	const prefix = "../../../../main/omp/tsp/fixtures/18.15.0/";
	const document = new TspDocument("s:1");
	for (const line of fixtures[`${prefix}hook-collab-aware.messages.jsonl`]!.trim().split("\n")) {
		const message: { verb: string; body: TspFrame } = JSON.parse(line);
		if (message.verb === "f") document.applyFrame(message.body);
	}
	const surface: TspHostSnapshot["surfaces"][number] = { open: { id: "s:1", mode: "inline" }, documentGeneration: 1, document: document.snapshot(), sequence: 3, closed: false, suspended: false, settled: [], focus: document.focus };
	const dialogs = hookQuestions([surface], 1); expect(dialogs).toHaveLength(1);
	const request: CollabUiRequest = { reqId: 4, kind: "select", title: dialogs[0]!.title, options: dialogs[0]!.options ?? [] };
	const scope = { hostId: "host", generation: 1, epoch: 1 };
	const arb = new QuestionArbitrator();
	arb.update(scope, { ...scope, connection: 1, revision: 1, connected: true, requests: status === "matched" ? [request] : [request, { ...request, reqId: 5 }] });
	const snapshot: TspHostSnapshot = { ...scope, revision: 1, lifecycle: "live", negotiated: true, documentGeneration: 1, availability: { available: false, reason: "Question open" }, failure: null, surfaces: [surface], questionMatches: arb.matches(scope, dialogs) };
	const invoke = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke, on: () => () => {} } });
	const answer = vi.fn();
	const session = { answer, getSnapshot: () => ({ strandedImages: false }) } as unknown as SessionController;
	await act(async () => root.render(createElement("div", null,
		createElement(OmpScreenSheet, { hostId: "host", generation: 1, snapshot, failed: false, readOnly: false }),
		createElement(QuestionCard, { session, request }),
	)));
	const local = element.querySelector('[role="region"]')!;
	expect(local.querySelector('[role="listbox"]')?.getAttribute("aria-disabled")).toBe("true");
	expect([...local.querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled)).toBe(true);
	const card = element.querySelector('[data-question-card="4"]')!;
	expect(card).not.toBeNull();
	await act(async () => card.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click());
	await act(async () => [...card.querySelectorAll<HTMLButtonElement>("button")].at(-1)!.click());
	expect(answer).toHaveBeenCalledExactlyOnceWith(4, "Second option");
	expect(invoke.mock.calls.some(call => ["host:tsp-answer", "host:tsp-event", "host:keys"].includes(call[0]))).toBe(false);
});
