// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { TspNode } from "@shared/tsp";
import type { NodeContext } from "./context";
import { NodeView } from "./NodeView";
import "../../../i18n";

it("wraps a diff's long lines unless omp sends wrap: false", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const context: NodeContext = { sf: "surface", readOnly: true, send: vi.fn(), keys: vi.fn(), render: () => null };
	const container = document.createElement("div");
	const root = createRoot(container);
	const diff = (wrap?: boolean): TspNode => ({ id: "diff", k: "diff", p: { text: "@@ -1 +1 @@\n-old\n+new", role: "omp.app.git.diff", ...(wrap === undefined ? {} : { wrap }) } });
	await act(async () => root.render(createElement(NodeView, { node: diff(), context })));
	expect(container.querySelector(".tv-diff")!.classList.contains("tv-diff--wrap")).toBe(true);
	await act(async () => root.render(createElement(NodeView, { node: diff(false), context })));
	expect(container.querySelector(".tv-diff")!.classList.contains("tv-diff--wrap")).toBe(false);
	expect(container.querySelector(".tv-diff-row--add")!.textContent).toBe("+new");
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});
