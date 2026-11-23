// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { TspNode } from "@shared/tsp";
import type { NodeContext } from "./context";
import { NodeView } from "./NodeView";
import "../../../i18n";

it("keeps the pills of omp 19's folded question out of the fold's button, so each click sends one action", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const send = vi.fn();
	const context: NodeContext = { sf: "surface", readOnly: false, send, keys: vi.fn(), render: () => null };
	const container = document.createElement("div");
	const root = createRoot(container);
	// The shape omp 19.0.0 records for a folded question: the fold opens it, and its pills pick an option.
	const fold: TspNode = { id: "fold", k: "col", p: { role: "omp.ask.fold", title: "Answer this question", actions: { click: "open:1" } }, c: [
		{ id: "question", k: "text", p: { role: "omp.ask.fold.question", spans: [{ t: "Platforms to check" }] } },
		{ id: "pills", k: "row", p: { role: "omp.ask.pills" }, c: [
			{ id: "macos", k: "button", p: { role: "omp.ask.pill", text: "macOS", size: "sm", on: true, actions: { click: "pick:1:0" } } },
			{ id: "linux", k: "button", p: { role: "omp.ask.pill", text: "Linux", size: "sm", actions: { click: "pick:1:2" } } },
		] },
	] };
	await act(async () => root.render(createElement(NodeView, { node: fold, context })));
	expect(container.querySelectorAll("button button")).toHaveLength(0);
	const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === label)!;
	expect(container.textContent).toContain("Platforms to check");
	await act(async () => button("Linux").click());
	expect(send.mock.calls).toEqual([[{ ev: "action", sf: "surface", id: "linux", act: "pick:1:2" }]]);
	send.mockClear();
	await act(async () => button("Answer this question").click());
	expect(send.mock.calls).toEqual([[{ ev: "action", sf: "surface", id: "fold", act: "open:1" }]]);
	// omp 19.1.1 puts the head in a row and shows a text answer under it; the answer stays outside the fold's button.
	const answered: TspNode = { id: "fold2", k: "col", p: { role: "omp.ask.fold", title: "Answer this question", actions: { click: "open:2" } }, c: [
		{ id: "head", k: "row", p: { role: "omp.ask.fold.head" }, c: [{ id: "mark", k: "text", p: { role: "omp.ask.fold.mark", text: "✓" } }, { id: "q2", k: "text", p: { role: "omp.ask.fold.question", text: "Release note headline" } }] },
		{ id: "answer", k: "text", p: { role: "omp.ask.fold.answer", text: "Handoffs are easier to follow" } },
	] };
	await act(async () => root.render(createElement(NodeView, { node: answered, context })));
	expect([...container.querySelectorAll("button")].map(item => item.textContent?.trim())).toEqual(["Answer this question"]);
	expect(container.textContent).toContain("Handoffs are easier to follow");
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

it("picks an answer of omp's open question in one click, shows the chosen answers and keeps the arrow keys local", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const send = vi.fn();
	const context: NodeContext = { sf: "surface", readOnly: false, send, keys: vi.fn(), render: () => null };
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	// omp 19.1.1's open multi-select question (`ask-dialog.ts`): chosen rows are toned `accent`, and `selected` is the cursor.
	const options: TspNode = { id: "q1", k: "list", p: { role: "omp.ask.options", selected: "o0" }, c: [
		{ id: "o0", k: "item", p: { role: "omp.ask.check", label: [{ t: "macOS" }], tone: "accent", icon: "check", actions: { menu: ["note"] } } },
		{ id: "o1", k: "item", p: { role: "omp.ask.check", label: [{ t: "Windows" }], value: [{ t: "Recommended" }], actions: { menu: ["note"] } } },
	] };
	await act(async () => root.render(createElement(NodeView, { node: options, context })));
	const rows = [...container.querySelectorAll<HTMLElement>("[role=option]")];
	expect(rows.map(row => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);
	expect(rows[1]!.textContent).toContain("Recommended");
	expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual([]);

	await act(async () => container.querySelector<HTMLElement>("[role=listbox]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
	expect(send).not.toHaveBeenCalled();
	await act(async () => rows[1]!.click());
	expect(send.mock.calls).toEqual([[{ ev: "select", sf: "surface", id: "q1", item: "o1" }]]);
	send.mockClear();
	await act(async () => container.querySelector<HTMLElement>("[role=listbox]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
	expect(send.mock.calls).toEqual([[{ ev: "activate", sf: "surface", id: "q1", item: "o1" }]]);
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

it("keeps omp's Esc hint in the working row as text, without an unavailable button", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	const root = createRoot(container);
	const context: NodeContext = { sf: "surface", readOnly: false, send: vi.fn(), keys: vi.fn(), render: () => null };
	const stop: TspNode = { id: "stop", k: "row", p: { role: "omp.working.stop", actions: { click: "interrupt" } }, c: [
		{ id: "stop-key", k: "text", p: { text: "Esc" } },
		{ id: "stop-text", k: "text", p: { text: "Stop" } },
	] };
	await act(async () => root.render(createElement(NodeView, { node: stop, context })));
	expect(container.textContent).toContain("Stop");
	expect(container.querySelector("button")).toBeNull();
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});
