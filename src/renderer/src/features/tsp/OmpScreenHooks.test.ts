// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TspDocument } from "../../../../main/omp/tsp/apply";
import { hookAnswerEvents } from "@shared/tsp/dialogs";
import type { TspFrame } from "@shared/tsp";
import { hookQuestions, QuestionArbitrator } from "@shared/tsp/question-match";
import { walkNodes } from "@shared/tsp/view-state";
import type { TspRendererEvent, TspSurfaceSnapshot } from "@shared/tsp-host";
import { NodeView } from "./nodes/NodeView";
import type { NodeContext } from "./nodes/context";
import "../../i18n";

const fixtures = import.meta.glob<string>("../../../../main/omp/tsp/fixtures/18.14.0/*.jsonl", { query: "?raw", import: "default", eager: true });

let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin" } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); Reflect.deleteProperty(window, "vomp"); });

it.each(["hook-select", "hook-confirm", "hook-input", "hook-editor", "hook-select-cancel", "hook-confirm-cancel", "hook-input-cancel", "hook-editor-cancel"])("completes recorded %s through the omp screen with the accepted native events", async name => {
	const prefix = "../../../../main/omp/tsp/fixtures/18.14.0/";
	const messages: { verb: string; body: unknown }[] = fixtures[`${prefix}${name}.messages.jsonl`]!.trim().split("\n").map(line => JSON.parse(line));
	const recorded: { verb: string; body: TspRendererEvent; afterMessage: number }[] = fixtures[`${prefix}${name}.events.jsonl`]!.trim().split("\n").map(line => JSON.parse(line));
	const candidates = recorded.filter(record => record.verb === "e" && ["activate", "edit", "action"].includes(record.body.ev));
	const edit = candidates.findLastIndex(record => record.body.ev === "edit");
	const expected = name.endsWith("cancel") ? candidates.slice(-1) : edit >= 0 ? candidates.slice(edit) : candidates;
	const emitted: TspRendererEvent[] = [];
	const document = new TspDocument("s:1");
	for (const message of messages.slice(0, expected[0]!.afterMessage)) if (message.verb === "f") document.applyFrame(message.body as TspFrame);
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
	for (const message of messages.slice(expected[0]!.afterMessage)) {
		if (message.verb === "f") document.applyFrame(message.body as TspFrame);
		if (message.verb === "x") surface.closed = true;
	}
	surface.document = document.snapshot();
	expect(hookQuestions([surface], 1)).toEqual([]);
});
