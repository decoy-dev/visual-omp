// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../../i18n";
import { parseSessionTree } from "./tree";
import { TreeSheet } from "./TreeSheet";

const fake = vi.hoisted(() => ({ transport: "classic" as "classic" | "tsp", toast: vi.fn(), open: vi.fn(), command: vi.fn(), navigate: vi.fn(), load: vi.fn() }));
const controller = { tabId: "tab", command: fake.command, getSnapshot: () => ({ host: { transport: fake.transport } }) };
vi.mock("../../state/app", () => ({ controllerFor: () => controller, useApp: { getState: () => ({ openTerminal: fake.open }) } }));
vi.mock("./navigate", () => ({ loadTree: (...args: unknown[]) => fake.load(...args), navigateTo: (...args: unknown[]) => fake.navigate(...args), forkChat: vi.fn(), NavigationError: Error }));
vi.mock("../../transcript/Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("p", null, text) }));
vi.mock("@/ui", () => ({
	Button: ({ children, onClick, disabled }: PropsWithChildren<{ onClick(): void; disabled?: boolean }>) => createElement("button", { onClick, disabled }, children),
	Expand: ({ open, children }: PropsWithChildren<{ open: boolean }>) => open ? children : null,
	PresenceSwap: ({ children }: PropsWithChildren) => children, Mark: () => null, EmptyState: () => null,
	cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "), spring: { snappy: {} }, toast: (...args: unknown[]) => fake.toast(...args),
}));
let root: Root; let element: HTMLDivElement;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.toast.mockClear(); fake.open.mockClear(); fake.command.mockClear(); fake.navigate.mockRejectedValue(new Error("Navigation unavailable"));
	fake.load.mockResolvedValue(parseSessionTree(JSON.stringify({ id: "user", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "A recorded prompt" } })));
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
it.each(["tsp", "classic"] as const)("names the tree fallback action for a %s chat", async transport => {
	fake.transport = transport;
	await act(async () => root.render(createElement(TreeSheet, { props: { tabId: "tab" }, close: vi.fn() })));
	const rewind = [...document.querySelectorAll("button")].find(button => button.textContent === "Rewind to here")!;
	expect(rewind).toBeDefined();
	await act(async () => rewind.click());
	expect(fake.toast).toHaveBeenCalledOnce();
	const action = fake.toast.mock.calls[0][0].action as { label: string; onClick(): void };
	expect(action.label).toBe(transport === "tsp" ? "Open tree in omp screen" : "Open tree in terminal");
	action.onClick();
	expect(fake.command).toHaveBeenCalledWith("/tree"); expect(fake.open).toHaveBeenCalledWith("tab");
});
