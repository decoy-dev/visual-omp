// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TSP_KINDS, type TspNode } from "@shared/tsp";
import { TSP_CLAIMS, TSP_ROLES } from "@shared/tsp/roles";
import { unclaimed } from "@shared/tsp/view-state";
import type { TspHostSnapshot, TspSurfaceSnapshot } from "@shared/tsp-host";
import "../../i18n";
import { KIND_GROUPS, NodeView } from "./nodes/NodeView";
import type { NodeContext } from "./nodes/context";
import { rawKey } from "./keys";
import { ansiRuns } from "./ansi";
import { OmpScreenSheet } from "./OmpScreenSheet";
import { TooltipProvider } from "../../ui/Tooltip";

let root: Root;
let element: HTMLDivElement;
let context: NodeContext;
const send = vi.fn(); const keys = vi.fn();
const render = async (node: TspNode) => { await act(async () => root.render(createElement(TooltipProvider, { children: createElement(NodeView, { node, context }) }))); };
const click = async (selector: string, type = "click") => { await act(async () => element.querySelector(selector)!.dispatchEvent(new MouseEvent(type, { bubbles: true }))); };
const press = async (key: string) => { await act(async () => element.querySelector('[role="listbox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))); };
beforeEach(() => {
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin" } });
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
	send.mockClear(); keys.mockClear(); context = { sf: "s:1", readOnly: false, send, keys, render: node => createElement(NodeView, { key: node.id, node, context }) };
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
it("enumerates every advertised kind, failing when the wire vocabulary grows", () => {
	expect(Object.keys(KIND_GROUPS).sort()).toEqual([...TSP_KINDS].sort());
	expect(Object.keys(KIND_GROUPS)).toHaveLength(45);
	expect(KIND_GROUPS.button).toBe("form");
});
it("mounts a renderer for all 45 kinds without invoking application input", async () => {
	for (const k of TSP_KINDS) {
		await render({ id: `kind-${k}`, k } as TspNode);
		expect(element.querySelector("[data-tsp-kind]")?.getAttribute("data-tsp-kind")).toBe(k);
	}
	expect(send).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
});
it("keeps list pointer selection local and activates on Enter", async () => {
	await render({ id: "list", k: "list", c: [{ id: "row", k: "item", p: { label: "Choose me", key: "option" } }] });
	await click('[role="option"]'); expect(send).not.toHaveBeenCalled();
	expect(element.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
	await press("Enter"); expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "activate", sf: "s:1", id: "list", item: "option" });
});
it("honors declared list click and double-click actions", async () => {
	await render({ id: "list", k: "list", c: [{ id: "row", k: "item", p: { label: "Choose me", key: "option", actions: { click: "select", dblclick: "close" } } }] });
	await click('[role="option"]'); expect(send).toHaveBeenLastCalledWith({ ev: "select", sf: "s:1", id: "list", item: "option" });
	await click('[role="option"]', "dblclick"); expect(send).toHaveBeenLastCalledWith({ ev: "action", sf: "s:1", id: "list", act: "close", value: "option" });
});
it("uses a picker's select preview and explicit action commitment", async () => {
	await render({ id: "picker", k: "picker", p: { title: "Models", query: null, items: [{ id: "a", label: "Model A" }], actions: [{ id: "assign", label: "Assign role", primary: true }] } });
	await click('[role="option"]'); expect(send).toHaveBeenLastCalledWith({ ev: "select", sf: "s:1", id: "picker", item: "a" });
	await click("button"); expect(send).toHaveBeenLastCalledWith({ ev: "action", sf: "s:1", id: "picker", act: "assign" });
});
it("does not navigate tree rows on click, including a generic list under a tree overlay", async () => {
	await render({ id: "overlay", k: "overlay", p: { role: TSP_ROLES.tree, head: "Session tree" }, c: [{ id: "list", k: "list", c: [{ id: "row", k: "item", p: { key: "entry", label: "A previous turn", actions: { click: "select" } } }] }] });
	await click('[role="option"]'); expect(send).not.toHaveBeenCalled();
	await press("Enter"); expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "activate", sf: "s:1", id: "list", item: "entry" });
});
it("keeps roleless data-first tree pickers local until confirmation", async () => {
	await render({ id: "tree-picker", k: "picker", p: { title: "Session tree", layout: "tree", query: null, items: [{ id: "entry", label: "Earlier turn" }], actions: [{ id: "switch", label: "Switch", primary: true }] } });
	await click('[role="option"]'); expect(send).not.toHaveBeenCalled();
	await click("button"); expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "activate", sf: "s:1", id: "tree-picker", item: "entry" });
});
it("preserves a tree label editor's explicit Save label action", async () => {
	await render({ id: "tree-picker", k: "picker", p: { title: "Session tree", layout: "tree", query: null, selected: "entry", items: [{ id: "entry", label: "Earlier turn" }], actions: [{ id: "label-save", label: "Save label", primary: true }] } });
	await click("button"); expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "action", sf: "s:1", id: "tree-picker", act: "label-save" });
});
it.each(["picker", "prefs"])("leaves Tab and Shift+Tab to browser focus traversal in %s search", async kind => {
	await render(kind === "picker" ? { id: "picker", k: "picker", p: { query: "", items: [] } } : { id: "prefs", k: "prefs", p: { title: "Settings", page: "page", pages: [], sections: [] } });
	for (const shiftKey of [false, true]) {
		const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
		await act(async () => element.querySelector("input")!.dispatchEvent(event));
		expect(event.defaultPrevented).toBe(false);
	}
	expect(keys).not.toHaveBeenCalled();
});
it("shows omp's effort glyph as a read-only level without inventing an editable receiver", async () => {
	await render({ id: "effort", k: "effort", p: { level: "high" } });
	expect(element.textContent).toContain("high");
	expect(element.querySelector("button,input,select,[role=combobox]")).toBeNull();
	expect(send).not.toHaveBeenCalled();
});
it("changes typed prefs values and sends page actions", async () => {
	await render({ id: "prefs", k: "prefs", p: { title: "Settings", page: "appearance", pages: [{ id: "appearance", label: "Appearance" }, { id: "agent", label: "Agent" }], sections: [{ id: "main", title: "Display", rows: [{ id: "theme", label: "Theme", control: { k: "choice", value: "light", options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }] } }, { id: "enabled", label: "Enabled", control: { k: "switch", on: false } }] }] } });
	await act(async () => element.querySelector('[role="combobox"][aria-label="Theme"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
	await act(async () => {
		const dark = [...document.querySelectorAll('[role="option"]')].find(option => option.textContent === "Dark")!;
		dark.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	});
	expect(send).toHaveBeenLastCalledWith({ ev: "change", sf: "s:1", id: "prefs", item: "theme", value: "dark" });
	await click('[role="switch"]'); expect(send).toHaveBeenLastCalledWith({ ev: "change", sf: "s:1", id: "prefs", item: "enabled", value: true });
	await click('[role="tab"]:nth-child(2)'); expect(send).toHaveBeenLastCalledWith({ ev: "action", sf: "s:1", id: "prefs", act: "page", value: "agent" });
});
it("shows hook dialogs read-only despite the existing classic OmpDialogCard", async () => {
	const hook: TspNode = { id: "hook", k: "overlay", p: { role: TSP_ROLES.hookSelect, head: "Choose an option" }, c: [{ id: "picker", k: "picker", p: { items: [{ id: "yes", label: "Yes" }], query: null } }] };
	expect(TSP_CLAIMS[TSP_ROLES.hookSelect]).toBeUndefined();
	const surface: TspSurfaceSnapshot = { open: { id: "s:1", mode: "inline" }, sequence: 1, closed: false, suspended: false, settled: [], focus: "hook", document: { id: "s:1", k: "col", c: [{ id: "layer", k: "col", c: [hook] }] } };
	expect(unclaimed(surface, "layer")).toHaveLength(1);
	await render(hook); expect(element.textContent).toContain("Waiting for the chat's question state");
	await click('[role="option"]'); await press("Enter"); expect(send).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
});
it.each(["matched", "ambiguous", "unavailable", "settling", "answering"] as const)("keeps %s hook dialogs display-only with a truthful reason", async status => {
	const answer = vi.fn().mockResolvedValue(undefined);
	context = { ...context, questionMatches: [{ surfaceId: "s:1", nodeId: "hook", status }], answer };
	await render({ id: "hook", k: "overlay", p: { role: TSP_ROLES.hookSelect, head: "Choose" }, c: [{ id: "list", k: "list", c: [{ id: "yes", k: "item", p: { label: "Yes" } }] }] });
	expect(element.querySelector('[role="status"]')?.textContent).toBeTruthy();
	if (status === "matched") expect(element.textContent).toContain("chat's question card");
	await click('[role="option"]'); await press("Enter");
	expect(answer).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
});
it("answers a roleless hook picker once and shows answering until the node departs", async () => {
	const answer = vi.fn().mockResolvedValue(undefined);
	context = { ...context, questionMatches: [{ surfaceId: "s:1", nodeId: "hook", status: "unmatched" }], answer };
	const hook: TspNode = { id: "hook", k: "picker", p: { title: "Choose", noun: "options", layout: "rows", query: null, selected: "0", items: [{ id: "0", label: "Yes" }, { id: "1", label: "No" }], actions: [{ id: "confirm", label: "Select", primary: true }, { id: "close", label: "Cancel" }] } };
	await render(hook); await click('[role="option"]:nth-child(2)');
	expect(answer).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
	await press("Enter");
	expect(answer).toHaveBeenCalledExactlyOnceWith({ kind: "choose", sf: "s:1", id: "hook", target: "hook", item: "1" });
	expect(element.textContent).toContain("Answering");
	await press("Enter"); expect(answer).toHaveBeenCalledTimes(1);
	await render({ id: "next", k: "text", p: { text: "Next overlay" } });
	expect(element.textContent).toContain("Next overlay"); expect(element.textContent).not.toContain("Answering");
});
it.each(["input", "editor"] as const)("keeps a local %s draft and submits one full answer using its observed length", async kind => {
	const answer = vi.fn().mockResolvedValue(undefined);
	context = { ...context, questionMatches: [{ surfaceId: "s:1", nodeId: "hook", status: "unmatched" }], answer };
	await render({ id: "hook", k: "col", p: { role: `omp.overlay.hook-${kind}` }, c: [{ id: "field", k: kind, p: { text: "seed" } }] });
	const field = element.querySelector("input,textarea") as HTMLInputElement;
	expect(field.readOnly).toBe(false); expect(field.value).toBe("seed");
	await click("button");
	expect(answer).toHaveBeenCalledExactlyOnceWith({ kind: "text", sf: "s:1", id: "hook", target: "field", text: "seed", len: 4 });
	expect(send).not.toHaveBeenCalled(); expect(element.textContent).toContain("Answering");
});
it.each(["unmatched", "matched", "ambiguous", "unavailable", "answering"] as const)("makes a %s hook unavailable while closing", async status => {
	const answer = vi.fn().mockResolvedValue(undefined);
	context = { ...context, closing: true, questionMatches: [{ surfaceId: "s:1", nodeId: "hook", status }], answer };
	await render({ id: "hook", k: "overlay", p: { role: TSP_ROLES.hookSelect, head: "Choose" }, c: [{ id: "list", k: "list", c: [{ id: "yes", k: "item", p: { label: "Yes" } }] }] });
	expect(element.textContent).toContain("This chat is closing.");
	await click('[role="option"]'); await press("Enter");
	expect(answer).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
	expect([...element.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
});
it("shows a calm completion message when a losing local answer finds that omp already closed its node", async () => {
	const answer = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'host:tsp-answer': Error: TSP preview: The question node is no longer available."));
	context = { ...context, questionMatches: [{ surfaceId: "s:1", nodeId: "hook", status: "unmatched" }], answer };
	await render({ id: "hook", k: "picker", p: { title: "Choose", noun: "options", layout: "rows", query: null, selected: "0", items: [{ id: "0", label: "Yes" }], actions: [{ id: "confirm", label: "Select" }, { id: "close", label: "Cancel" }] } });
	await press("Enter");
	expect(answer).toHaveBeenCalledOnce();
	expect(element.querySelector('[role="alert"]')).toBeNull();
	expect(element.textContent).toContain("This question has closed.");
	expect(element.textContent).not.toContain("Answering.");
	await press("Enter"); expect(answer).toHaveBeenCalledOnce();
});
it("passes main's closing snapshot through the omp screen to its hook controls", async () => {
	const previous = window.vomp;
	const invoke = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
	const hook: TspNode = { id: "hook", k: "overlay", p: { role: TSP_ROLES.hookSelect, head: "Choose" }, c: [{ id: "list", k: "list", c: [{ id: "yes", k: "item", p: { label: "Yes" } }] }] };
	const snapshot: TspHostSnapshot = { hostId: "host", generation: 1, epoch: 1, revision: 1, closing: true, negotiated: true, lifecycle: "live", documentGeneration: 1, availability: { available: false, reason: "This chat is closing." }, failure: null, questionMatches: [{ surfaceId: "s:1", nodeId: "hook", status: "unmatched" }], surfaces: [{ open: { id: "s:1", mode: "inline" }, documentGeneration: 1, sequence: 1, closed: false, suspended: false, focus: null, settled: [], document: { id: "s:1", k: "col", c: [{ id: "layer", k: "col", c: [hook] }] } }] };
	try {
		await act(async () => root.render(createElement(OmpScreenSheet, { hostId: "host", generation: 1, snapshot, failed: false, readOnly: false })));
		expect(element.textContent).toContain("This chat is closing.");
		await click('[role="option"]'); await press("Enter");
		expect(invoke).not.toHaveBeenCalledWith("host:tsp-answer", expect.anything(), expect.anything(), expect.anything(), expect.anything());
		expect(element.querySelector('[role="listbox"]')?.getAttribute("aria-disabled")).toBe("true");
	} finally {
		if (previous) Object.defineProperty(window, "vomp", { configurable: true, value: previous });
		else Reflect.deleteProperty(window, "vomp");
	}
});
it("renders rows as safe ANSI spans and forwards focused raw keys", async () => {
	await render({ id: "fallback", k: "rows", p: { cols: 80, lines: ["\x1b[31mError\x1b[0m", "<script>not HTML</script>"] } });
	expect(element.querySelector("pre")?.textContent).toBe("Error\n<script>not HTML</script>"); expect(element.querySelector("script")).toBeNull();
	await act(async () => element.querySelector("pre")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
	expect(keys).toHaveBeenCalledWith("\x1b[B");
});
it.each(["rows", "ansi"] as const)("focuses %s in the browser and forwards raw keys without a semantic focus write", async kind => {
	await render(kind === "rows" ? { id: "raw", k: "rows", p: { cols: 80, lines: ["Raw omp output"] } } : { id: "raw", k: "ansi", p: { text: "Raw omp output" } });
	const block = element.querySelector("pre")!;
	await act(async () => block.focus());
	expect(document.activeElement).toBe(block);
	expect(send).not.toHaveBeenCalled();
	await act(async () => block.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
	expect(keys).toHaveBeenCalledExactlyOnceWith("\r");
	expect(send).not.toHaveBeenCalled();
});
it.each(["input", "editor"] as const)("keeps semantic focus events for an ordinary %s control", async kind => {
	await render({ id: "field", k: kind, p: { text: "Current value" } });
	await act(async () => element.querySelector<HTMLElement>("input,textarea")!.focus());
	expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "focus", sf: "s:1", id: "field" });
	expect(keys).not.toHaveBeenCalled();
});
it("logs unknown kinds, roles and actions once while keeping content readable without dumping props", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const unknown = { id: "unknown", k: "future-kind", p: { text: "Readable future output" } } as unknown as TspNode;
	await render(unknown); await render(unknown); expect(element.textContent).toContain("Readable future output");
	await render({ id: "unknown-role", k: "text", p: { role: "omp.future-role", text: "New role" } });
	await render({ id: "unknown-role", k: "text", p: { role: "omp.future-role", text: "New role" } });
	expect(element.textContent).toContain("New role"); expect(element.querySelector("pre")).toBeNull();
	const action: TspNode = { id: "unknown-action", k: "text", p: { text: "Future control", actions: { click: "future-action" } } };
	await render(action); await render(action); expect(element.textContent).toContain("Future control");
	expect(element.querySelector("pre")).toBeNull();
	expect(element.querySelector("button")?.disabled).toBe(true);
	expect(element.querySelector("button")?.title).toContain("future-action");
	await click("button"); expect(send).not.toHaveBeenCalled();
	expect(warning).toHaveBeenCalledTimes(3); warning.mockRestore();
});
it.each(["col", "row", "section", "card"] as const)("renders an unknown-role %s as layout with readable children", async k => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	await render({ id: "container", k, p: { role: `omp.future-${k}` }, c: [{ id: "child", k: "text", p: { text: "Visible child" } }] });
	expect(element.textContent).toBe("Visible child");
	expect(element.querySelector("pre")).toBeNull();
	expect(element.textContent).not.toContain("gap"); expect(element.textContent).not.toContain("role");
	warning.mockRestore();
});
it("shows an unknown-kind message without exposing its props when no readable text exists", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	await render({ id: "unknown-data", k: "future-data", p: { metadata: { internal: "Private implementation details" } } } as unknown as TspNode);
	expect(element.querySelector("pre")?.textContent).toContain("omp content type future-data is not supported");
	expect(element.textContent).not.toContain("metadata"); expect(element.textContent).not.toContain("Private implementation");
	warning.mockRestore();
});
it("keeps unclaimed main output and suppresses only the replicated transcript and composer", () => {
	const surface: TspSurfaceSnapshot = { open: { id: "s", mode: "inline" }, sequence: 1, closed: false, suspended: false, settled: [], focus: null, document: { id: "s", k: "col", c: [{ id: "main", k: "col", c: [{ id: "reply", k: "md", p: { role: TSP_ROLES.assistant, text: "Replicated" } }, { id: "notice", k: "text", p: { text: "Local notice" } }] }] } };
	expect(unclaimed(surface, "main").map(node => node.id)).toEqual(["notice"]);
});
it("does not turn terminal escape controls into links and preserves keyboard boundaries", () => {
	expect(ansiRuns("\x1b]8;;https://evil.test\x07link\x1b]8;;\x07").map(run => run.text).join("")).toBe("link");
	expect(rawKey({ key: "Escape", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })).toBeNull();
});

it("disables only unsupported picker actions while selection, known actions and children remain interactive", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const picker: TspNode = { id: "extensions", k: "picker", p: { title: "Extension Control Center", layout: "rows", focus: "list", query: null,
		items: [{ id: "fixture", label: "Fixture extension" }, { id: "other", label: "Another extension" }],
		actions: [{ id: "toggle", label: "Toggle", disabled: "Select an extension" }, { id: "future-expand", label: "Expand" }, { id: "close", label: "Close" }] },
		c: [{ id: "child", k: "text", p: { text: "Known child action", actions: { click: "close" } } }] };
	await render(picker); await render(picker);
	const expand = [...element.querySelectorAll("button")].find(button => button.textContent === "Expand")!;
	expect(expand.disabled).toBe(true); expect(expand.title).toContain("future-expand");
	await act(async () => expand.click()); expect(send).not.toHaveBeenCalled();
	await click('[role="option"]');
	expect(send).toHaveBeenLastCalledWith({ ev: "select", sf: "s:1", id: "extensions", item: "fixture" });
	await press("ArrowDown");
	expect(send).toHaveBeenLastCalledWith({ ev: "select", sf: "s:1", id: "extensions", item: "other" });
	const close = [...element.querySelectorAll("button")].find(button => button.textContent === "Close")!;
	expect(close.disabled).toBe(false);
	await act(async () => close.click());
	expect(send).toHaveBeenLastCalledWith({ ev: "action", sf: "s:1", id: "extensions", act: "close" });
	await click('[data-tsp-id="child"] > button');
	expect(send).toHaveBeenLastCalledWith({ ev: "action", sf: "s:1", id: "child", act: "close" });
	expect(warning).toHaveBeenCalledExactlyOnceWith("TSP screen fallback: action:future-expand");
	warning.mockRestore();
});
it("leaves known node clicks and descendants enabled when a different declared action is unsupported", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	await render({ id: "parent", k: "col", p: { actions: { dblclick: "future-double" } }, c: [{ id: "child", k: "text", p: { text: "Close", actions: { click: "close" } } }] });
	await click('[data-tsp-id="child"] > button');
	expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "action", sf: "s:1", id: "child", act: "close" });
	warning.mockRestore();
});
it("keeps unknown preference actions display-only without disabling unrelated preference controls", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	await render({ id: "prefs", k: "prefs", p: { title: "Settings", page: "main", pages: [], sections: [{ id: "main", title: "Main", rows: [
		{ id: "future", label: "Future action", control: { k: "action", label: "Unsupported", act: "future-prefs" } },
		{ id: "known", label: "Known action", control: { k: "action", label: "Close", act: "close" } },
		{ id: "switch", label: "Enabled", control: { k: "switch", on: false } },
	] }] } });
	const unsupported = [...element.querySelectorAll("button")].find(button => button.textContent === "Unsupported")!;
	expect(unsupported.disabled).toBe(true); expect(unsupported.title).toContain("future-prefs");
	await act(async () => unsupported.click()); expect(send).not.toHaveBeenCalled();
	await click('[role="switch"]');
	expect(send).toHaveBeenLastCalledWith({ ev: "change", sf: "s:1", id: "prefs", item: "switch", value: true });
	const close = [...element.querySelectorAll("button")].find(button => button.textContent === "Close")!;
	await act(async () => close.click());
	expect(send).toHaveBeenLastCalledWith({ ev: "action", sf: "s:1", id: "prefs", act: "close", value: "known" });
	warning.mockRestore();
});
it("renders unclaimed main content under Other omp output through the complete screen", async () => {
	const snapshot: TspHostSnapshot = { hostId: "host", epoch: 1, generation: 1, revision: 1, lifecycle: "live", negotiated: true, documentGeneration: 1, availability: { available: true, reason: null }, failure: null,
		surfaces: [{ open: { id: "s", mode: "inline" }, documentGeneration: 1, closed: false, sequence: 1, suspended: false, settled: [], focus: null, document: { id: "s", k: "col", c: [{ id: "main", k: "col", c: [
			{ id: "reply", k: "text", p: { role: TSP_ROLES.assistant, text: "Replicated reply" } }, { id: "local", k: "text", p: { text: "Local-only output" } },
		] }] } }] };
	await act(async () => root.render(createElement(OmpScreenSheet, { hostId: "host", generation: 1, snapshot, failed: false, readOnly: true })));
	expect(element.querySelector("h3")?.textContent).toBe("Other omp output");
	expect(element.textContent).toContain("Local-only output");
	expect(element.textContent).not.toContain("Replicated reply");
});

it("keeps descendants interactive when an unsupported click belongs to their container", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	await render({ id: "parent", k: "col", p: { actions: { click: "future-container" } }, c: [{ id: "child", k: "text", p: { text: "Close child", actions: { click: "close" } } }] });
	expect(element.querySelector('[data-tsp-id="parent"] > button')?.getAttribute("disabled")).not.toBeNull();
	expect(element.querySelector('[data-tsp-id="child"] > button')?.closest("button")?.parentElement?.closest("button")).toBeNull();
	await click('[data-tsp-id="child"] > button');
	expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "action", sf: "s:1", id: "child", act: "close" });
	warning.mockRestore();
});
it("keeps known list row gestures active when another row gesture is unsupported and logs that action once", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const node: TspNode = { id: "list", k: "list", c: [{ id: "row", k: "item", p: { key: "entry", label: "Entry", actions: { click: "select", dblclick: "future-row" } } }] };
	await render(node); await render(node);
	await click('[role="option"]');
	expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "select", sf: "s:1", id: "list", item: "entry" });
	await click('[role="option"]', "dblclick"); expect(send).toHaveBeenCalledTimes(1);
	expect(warning).toHaveBeenCalledExactlyOnceWith("TSP screen fallback: action:future-row");
	warning.mockRestore();
});

it("renders kept surface history read-only while routing new surface controls to the live surface", async () => {
	const previous = window.vomp;
	const invoke = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke, on: () => () => {} } });
	const snapshot: TspHostSnapshot = { hostId: "host", epoch: 3, generation: 1, revision: 1, lifecycle: "live", negotiated: true, documentGeneration: 1, availability: { available: false, reason: "Menu open" }, failure: null, surfaces: [
		{ open: { id: "old", mode: "inline" }, documentGeneration: 1, closed: true, sequence: 2, suspended: false, settled: [], focus: null, document: { id: "old", k: "col", c: [{ id: "main", k: "col", c: [{ id: "retained-input", k: "input", p: { aria: "Retained input", text: "Saved output" } }] }] } },
		{ open: { id: "new", mode: "screen" }, documentGeneration: 1, closed: false, sequence: 1, suspended: false, settled: [], focus: "picker", document: { id: "new", k: "col", c: [{ id: "main", k: "col", c: [{ id: "picker", k: "picker", p: { title: "Current menu", query: null, items: [{ id: "next", label: "Next" }], actions: [{ id: "close", label: "Close" }] } }] }] } },
	] };
	try {
		await act(async () => root.render(createElement(OmpScreenSheet, { hostId: "host", generation: 1, snapshot, failed: false, readOnly: false })));
		expect(element.textContent).toContain("Its output is read-only");
		const old = element.querySelector<HTMLInputElement>('[aria-label="Retained input"]')!;
		expect(old.value).toBe("Saved output"); expect(old.readOnly).toBe(true);
		await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(old, "Unsaved edit"); old.dispatchEvent(new Event("input", { bubbles: true })); });
		expect(invoke.mock.calls.filter(call => call[0] === "host:tsp-event")).toEqual([]);
		await act(async () => element.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(invoke).toHaveBeenCalledWith("host:tsp-event", "host", 1, { ev: "select", sf: "new", id: "picker", item: "next" }, 3);
	} finally {
		if (previous) Object.defineProperty(window, "vomp", { configurable: true, value: previous });
		else Reflect.deleteProperty(window, "vomp");
	}
});

it("keeps intrinsic prefs controls working when their node declares an unsupported click without children", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	await render({ id: "prefs", k: "prefs", p: { title: "Settings", actions: { click: "future-prefs-click" }, page: "main", pages: [], sections: [{ id: "main", title: "Main", rows: [
		{ id: "enabled", label: "Enabled", control: { k: "switch", on: false } },
		{ id: "close", label: "Close settings", control: { k: "action", label: "Close", act: "close" } },
	] }] } });
	const toggle = element.querySelector<HTMLButtonElement>('[role="switch"]')!;
	expect(toggle.disabled).toBe(false); expect(toggle.parentElement?.closest("button")).toBeNull();
	await act(async () => toggle.click());
	expect(send).toHaveBeenLastCalledWith({ ev: "change", sf: "s:1", id: "prefs", item: "enabled", value: true });
	await act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === "Close")!.click());
	expect(send).toHaveBeenLastCalledWith({ ev: "action", sf: "s:1", id: "prefs", act: "close", value: "close" });
	const unsupported = element.querySelector<HTMLButtonElement>('[data-tsp-id="prefs"] > button')!;
	expect(unsupported.disabled).toBe(true); expect(unsupported.title).toContain("future-prefs-click");
	warning.mockRestore();
});
it.each(["input", "editor"] as const)("keeps intrinsic %s editing and submit working alongside an unsupported node click", async kind => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	await render({ id: "field", k: kind, p: { text: "seed", actions: { click: `future-${kind}-click` } } });
	const field = element.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
	expect(field.readOnly).toBe(false); expect(field.closest("button")).toBeNull();
	await act(async () => {
		const prototype = kind === "editor" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, "updated");
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(send).toHaveBeenLastCalledWith({ ev: "edit", sf: "s:1", id: "field", from: 0, to: 4, text: "updated", cursor: 7, len: 4 });
	await act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === "Submit")!.click());
	expect(send).toHaveBeenLastCalledWith({ ev: "action", sf: "s:1", id: "field", act: "submit" });
	expect(element.querySelector<HTMLButtonElement>('[data-tsp-id="field"] > button')?.disabled).toBe(true);
	warning.mockRestore();
});
it("explains unsupported double-click and menu actions on a row without blocking selection", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	await render({ id: "list", k: "list", c: [{ id: "row", k: "item", p: { label: "Entry", key: "entry", actions: { click: "select", dblclick: "future-double-reason", menu: ["future-menu-reason"] } } }] });
	const row = element.querySelector<HTMLElement>('[role="option"]')!;
	expect(row.title).toContain("The omp action future-double-reason is not supported");
	expect(row.title).toContain("The omp action future-menu-reason is not supported");
	await click('[role="option"]');
	expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "select", sf: "s:1", id: "list", item: "entry" });
	await click('[role="option"]', "dblclick");
	await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
	expect(send).toHaveBeenCalledTimes(1);
	warning.mockRestore();
});
it("explains an unsupported row click while keeping local selection and Enter activation available", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	await render({ id: "list", k: "list", c: [{ id: "row", k: "item", p: { label: "Entry", key: "entry", actions: { click: "future-click-reason" } } }] });
	const row = element.querySelector<HTMLElement>('[role="option"]')!;
	expect(row.title).toContain("The omp action future-click-reason is not supported");
	await click('[role="option"]');
	expect(row.getAttribute("aria-selected")).toBe("true"); expect(send).not.toHaveBeenCalled();
	await press("Enter");
	expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "activate", sf: "s:1", id: "list", item: "entry" });
	warning.mockRestore();
});
it.each(["default", "primary", "quiet", "danger"] as const)("renders a %s button once with its icon, keycaps and click action", async variant => {
	await render({ id: "push", k: "button", p: { text: "Close view", icon: "close", keys: ["escape"], variant, size: "sm", on: true, actions: { click: "close" } } });
	expect(element.querySelectorAll("button")).toHaveLength(1);
	expect(element.querySelector("button")?.textContent).toContain("Close view");
	expect(element.querySelector("button svg")).not.toBeNull();
	expect(element.querySelector("button kbd")).not.toBeNull();
	expect(element.querySelector("button")?.getAttribute("aria-pressed")).toBe("true");
	expect(element.querySelector("button")?.className).toContain("min-h-7");
	await click("button");
	expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "action", sf: "s:1", id: "push", act: "close" });
});
it.each(["disabled", "busy", "readonly", "unknown"] as const)("keeps a %s button inert and exposes its state", async state => {
	context = { ...context, readOnly: state === "readonly" };
	await render({ id: "push", k: "button", p: { text: "Submit", disabled: state === "disabled" ? "Choose an option first" : false, busy: state === "busy", actions: { click: state === "unknown" ? "future-button-action" : "submit" } } });
	const button = element.querySelector("button")!;
	expect(button.disabled).toBe(true);
	if (state === "disabled") expect(button.title).toBe("Choose an option first");
	if (state === "unknown") expect(button.title).toContain("future-button-action");
	if (state === "busy") expect(button.getAttribute("aria-busy")).toBe("true");
	await click("button"); expect(send).not.toHaveBeenCalled();
});
it("renders an accessible icon-only button and defaults its action to click", async () => {
	await render({ id: "push", k: "button", p: { icon: "close", aria: "Close view", variant: "quiet", on: true } });
	expect(element.querySelector("button")?.getAttribute("aria-label")).toBe("Close view");
	expect(element.querySelector("button")?.getAttribute("aria-pressed")).toBe("true");
	await click("button"); expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "action", sf: "s:1", id: "push", act: "click" });
});
it("keeps an icon button's accessible name while exposing its disabled reason", async () => {
	await render({ id: "push", k: "button", p: { icon: "close", aria: "Close view", disabled: "Waiting for omp", actions: { click: "close" } } });
	expect(element.querySelector("button")?.getAttribute("aria-label")).toBe("Close view");
	expect(element.querySelector("button")?.title).toBe("Waiting for omp");
	await click("button"); expect(send).not.toHaveBeenCalled();
});
it("renders segmented tabs using the shared selection control", async () => {
	await render({ id: "segments", k: "tabs", p: { variant: "segmented", active: "a", items: [{ id: "a", label: "First" }, { id: "b", label: "Second" }] } });
	expect(element.querySelector('[data-state="on"]')?.textContent).toBe("First");
	await click('button[data-state="off"]');
	expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "select", sf: "s:1", id: "segments", item: "b" });
	context = { ...context, readOnly: true };
	await render({ id: "segments", k: "tabs", p: { variant: "segmented", active: "a", items: [{ id: "a", label: "First" }] } });
	expect(element.querySelector("button")?.disabled).toBe(true);
});
it("preserves non-contiguous code numbers and inserts only the corresponding gap rows", async () => {
	await render({ id: "code", k: "code", p: { text: "first\nsecond\nfifth\nsixth", start: 99, nums: [1, 2, 5, 6], numbers: true } });
	expect([...element.querySelectorAll("[data-tsp-line]")].map(line => line.getAttribute("data-tsp-line"))).toEqual(["1", "2", "5", "6"]);
	expect(element.querySelectorAll(".tsp-code-gap")).toHaveLength(1);
	expect(element.querySelector("pre")?.textContent).toContain("…\n5fifth");
});
it.each([{ nums: [4] }, { nums: [4, 4] }, { nums: [5, 4] }])("falls back to start for invalid code numbers $nums", async ({ nums }) => {
	await render({ id: "code", k: "code", p: { text: "first\nsecond", start: 10, nums, numbers: true } });
	expect([...element.querySelectorAll("[data-tsp-line]")].map(line => line.getAttribute("data-tsp-line"))).toEqual(["10", "11"]);
	expect(element.querySelector(".tsp-code-gap")).toBeNull();
});
it("keeps gap rows when code gutters are explicitly hidden", async () => {
	await render({ id: "code", k: "code", p: { text: "first\nfifth", nums: [1, 5], numbers: false } });
	expect(element.querySelector(".tsp-code-number")).toBeNull();
	expect(element.querySelectorAll(".tsp-code-gap")).toHaveLength(1);
});
it("shows deferred nativeTail shell and eval blocks under Other omp output", async () => {
	const snapshot: TspHostSnapshot = { hostId: "host", generation: 1, epoch: 1, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 1, availability: { available: true, reason: null }, failure: null, surfaces: [{ open: { id: "s:1", mode: "inline" }, documentGeneration: 1, sequence: 1, closed: false, suspended: false, focus: null, settled: [], document: { id: "s:1", k: "col", c: [{ id: "main", k: "col", c: [
		{ id: "replicated", k: "tool", p: { role: "omp.tool", name: "bash", title: "Already in transcript", status: "done" } },
		...(["omp.bash", "omp.eval"] as const).map((role, i) => ({ id: `tail-${i}`, k: "tool" as const, p: { role, name: i ? "eval" : "bash", title: i ? "Python" : "Bash", status: "done" as const }, c: [{ id: `output-${i}`, k: "text" as const, p: { text: `Deferred output ${i}` } }] })),
	] }] } }] };
	await act(async () => root.render(createElement(OmpScreenSheet, { hostId: "host", generation: 1, snapshot, failed: false, readOnly: true })));
	expect(element.textContent).toContain("Other omp output");
	expect(element.textContent).toContain("Deferred output 0"); expect(element.textContent).toContain("Deferred output 1");
	expect(element.textContent).not.toContain("Already in transcript");
});
it("treats an empty disabled reason as disabled rather than enabling a native button", async () => {
	await render({ id: "push", k: "button", p: { text: "Submit", disabled: "", actions: { click: "submit" } } });
	expect(element.querySelector("button")?.disabled).toBe(true);
	await click("button"); expect(send).not.toHaveBeenCalled();
});
it("wraps long native button labels and keycaps without dropping the full accessible label", async () => {
	const text = "Close this deliberately long view label " + "unbroken".repeat(24);
	await render({ id: "push", k: "button", p: { text, keys: ["ctrl", "shift", "enter"], actions: { click: "close" } } });
	const button = element.querySelector("button")!;
	expect(button.textContent).toContain(text);
	expect(button.className).toContain("whitespace-normal");
	expect(button.className).toContain("h-auto");
	expect(button.querySelector('[class*="overflow-wrap:anywhere"]')?.textContent).toBe(text);
	expect(button.querySelector('[class*="tsp-key-chord"]')).not.toBeNull();
	await click("button"); expect(send).toHaveBeenCalledExactlyOnceWith({ ev: "action", sf: "s:1", id: "push", act: "close" });
});
it("names a key-only button from its displayed keys", async () => {
	await render({ id: "push", k: "button", p: { keys: ["ctrl", "enter"], actions: { click: "submit" } } });
	expect(element.querySelector("button")?.getAttribute("aria-label")).toBe("Control + Enter");
	expect(element.textContent).not.toContain("Unavailable action");
});
it("shows an inert readable fallback when a button has no label, icon or keys", async () => {
	await render({ id: "push", k: "button" });
	expect(element.querySelector("button")?.disabled).toBe(true);
	expect(element.textContent).toContain("Unavailable action");
	await click("button"); expect(send).not.toHaveBeenCalled();
});
