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
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});
