// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TSP_KINDS, type TspNode } from "@shared/tsp";
import { TSP_CLAIMS, TSP_ROLES, roleInteraction } from "@shared/tsp/roles";
import { unclaimed } from "@shared/tsp/view-state";
import type { TspSurfaceSnapshot } from "@shared/tsp-host";
import "../../i18n";
import { KIND_GROUPS, NodeView } from "./nodes/NodeView";
import type { NodeContext } from "./nodes/context";
import { rawKey } from "./keys";
import { ansiRuns } from "./ansi";

let root: Root;
let element: HTMLDivElement;
let context: NodeContext;
const send = vi.fn(); const keys = vi.fn();
const render = async (node: TspNode) => { await act(async () => root.render(createElement(NodeView, { node, context }))); };
const click = async (selector: string, type = "click") => { await act(async () => element.querySelector(selector)!.dispatchEvent(new MouseEvent(type, { bubbles: true }))); };
const press = async (key: string) => { await act(async () => element.querySelector('[role="listbox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))); };
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
	send.mockClear(); keys.mockClear(); context = { sf: "s:1", readOnly: false, send, keys, render: node => createElement(NodeView, { key: node.id, node, context }) };
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
it("enumerates every advertised kind, failing when the wire vocabulary grows", () => {
	expect(Object.keys(KIND_GROUPS).sort()).toEqual([...TSP_KINDS].sort());
	expect(Object.keys(KIND_GROUPS)).toHaveLength(44);
});
it("mounts a renderer for all 44 kinds without invoking application input", async () => {
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
	expect(TSP_CLAIMS[TSP_ROLES.hookSelect]).toBeUndefined(); expect(roleInteraction(TSP_ROLES.hookSelect)).toBe("display-only");
	const surface: TspSurfaceSnapshot = { open: { id: "s:1", mode: "inline" }, sequence: 1, closed: false, suspended: false, settled: [], focus: "hook", document: { id: "s:1", k: "col", c: [{ id: "layer", k: "col", c: [hook] }] } };
	expect(unclaimed(surface, "layer")).toHaveLength(1);
	await render(hook); expect(element.textContent).toContain("If it also appears in chat, answer it there.");
	await click('[role="option"]'); await press("Enter"); expect(send).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
});
it("renders rows as safe ANSI spans and forwards focused raw keys", async () => {
	await render({ id: "fallback", k: "rows", p: { cols: 80, lines: ["\x1b[31mError\x1b[0m", "<script>not HTML</script>"] } });
	expect(element.querySelector("pre")?.textContent).toBe("Error\n<script>not HTML</script>"); expect(element.querySelector("script")).toBeNull();
	await act(async () => element.querySelector("pre")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
	expect(keys).toHaveBeenCalledWith("\x1b[B");
});
it("logs unknown kinds, roles and actions only once and preserves their properties", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const unknown = { id: "unknown", k: "future-kind", p: { text: "Readable future output" } } as unknown as TspNode;
	await render(unknown); await render(unknown); expect(element.textContent).toContain("Readable future output");
	await render({ id: "unknown-role", k: "text", p: { role: "omp.future-role", text: "New role" } });
	expect(element.querySelector("pre")?.textContent).toContain("New role");
	const action: TspNode = { id: "unknown-action", k: "text", p: { text: "Future control", actions: { click: "future-action" } } };
	await render(action); await render(action); expect(element.querySelector("pre")?.textContent).toContain("future-action");
	expect(warning).toHaveBeenCalledTimes(3); warning.mockRestore();
});
it("keeps unclaimed main output and suppresses only the replicated transcript and composer", () => {
	const surface: TspSurfaceSnapshot = { open: { id: "s", mode: "inline" }, sequence: 1, closed: false, suspended: false, settled: [], focus: null, document: { id: "s", k: "col", c: [{ id: "main", k: "col", c: [{ id: "reply", k: "md", p: { role: TSP_ROLES.assistant, text: "Replicated" } }, { id: "notice", k: "text", p: { text: "Local notice" } }] }] } };
	expect(unclaimed(surface, "main").map(node => node.id)).toEqual(["notice"]);
});
it("does not turn terminal escape controls into links and preserves keyboard boundaries", () => {
	expect(ansiRuns("\x1b]8;;https://evil.test\x07link\x1b]8;;\x07").map(run => run.text).join("")).toBe("link");
	expect(rawKey({ key: "Escape", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })).toBeNull();
});
