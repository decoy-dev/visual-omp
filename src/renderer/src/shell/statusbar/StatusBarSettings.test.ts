// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import settingsMessages from "../../i18n/en/settings.json";
import { StatusBarSettings } from "../../features/manage/settings/StatusBarSettings";
import { StatusBarMenu } from "./StatusBarMenu";
import type { StatusBarPreference } from "@shared/statusBar";
import { TooltipProvider } from "../../ui";

const fake = vi.hoisted(() => ({ preference: { hidden: ["chat.context"], order: [] } as StatusBarPreference, save: vi.fn() }));
vi.mock("../../state/app", () => ({ useApp: Object.assign((select: (state: unknown) => unknown) => select({ prefs: { statusBar: fake.preference } }), { getState: () => ({ setPrefs: fake.save }) }) }));
vi.mock("../../registry/slots", () => ({ statusItems: { use: () => [
	{ id: "git.branch", title: "settings:status.items.branch", side: "left", order: 10 },
	{ id: "chat.context", title: "settings:status.items.context", side: "left", order: 20 },
	{ id: "omp.status", title: "settings:status.items.omp", side: "right", order: 10, locked: true },
	{ id: "app.update", title: "settings:status.items.update", side: "right", order: 20, locked: true },
] } }));
vi.mock("../../state/navigation", () => ({ openSettings: vi.fn() }));
let root: Root; let element: HTMLDivElement;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	i18n.addResourceBundle("en", "settings", settingsMessages);
	fake.preference = { hidden: ["chat.context"], order: [] }; fake.save.mockReset().mockResolvedValue(undefined);
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
it("shows visibility choices and locked recovery controls in Appearance", async () => {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(StatusBarSettings))));
	const boxes = [...element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
	expect(boxes.map(box => [box.checked, box.disabled])).toEqual([[true, false], [false, false], [true, true], [true, true]]);
	await act(async () => boxes[1]!.click());
	expect(fake.save).toHaveBeenLastCalledWith({ statusBar: { hidden: [], order: [] } });
});
it("reorders by keyboard, announces the new position and preserves focused handle", async () => {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(StatusBarSettings))));
	const handle = element.querySelector<HTMLButtonElement>('button[aria-label^="Reorder Context use"]')!;
	await act(async () => { handle.focus(); handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
	expect(fake.save).toHaveBeenCalledWith({ statusBar: { hidden: ["chat.context"], order: ["omp.status", "app.update", "chat.context", "git.branch"] } });
	expect(element.querySelector('[aria-live="polite"]')?.textContent).toBe("Context use moved to position 1 of 2.");
	expect(document.activeElement).toBe(handle);
});
it("reorders by drag within one side", async () => {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(StatusBarSettings))));
	const rows = element.querySelectorAll("li");
	const transfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
	await act(async () => rows[1]!.dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true }), { dataTransfer: transfer })));
	await act(async () => rows[0]!.dispatchEvent(Object.assign(new Event("dragover", { bubbles: true, cancelable: true }), { dataTransfer: transfer, clientY: -1 })));
	await act(async () => rows[0]!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })));
	expect(fake.save.mock.calls[0]?.[0].statusBar.order).toEqual(["omp.status", "app.update", "chat.context", "git.branch"]);
});
it.each([
	["Move Context use up", "Context use", ["omp.status", "app.update", "chat.context", "git.branch"], 1],
	["Move Git branch down", "Git branch", ["omp.status", "app.update", "chat.context", "git.branch"], 2],
] as const)("reorders through %s and restores the handle focus", async (label, name, order, position) => {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(StatusBarSettings))));
	const button = element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
	await act(async () => button.click());
	expect(fake.save).toHaveBeenLastCalledWith({ statusBar: { hidden: ["chat.context"], order } });
	expect(element.querySelector('[aria-live="polite"]')?.textContent).toBe(`${name} moved to position ${position} of 2.`);
	expect(document.activeElement).toBe(element.querySelector(`button[aria-label^="Reorder ${name},"]`));
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Move Git branch up"]')?.disabled).toBe(true);
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Move Context use down"]')?.disabled).toBe(true);
});
it("offers a checklist in the context menu and disables both recovery rows", async () => {
	element.tabIndex = -1;
	const close = vi.fn();
	await act(async () => root.render(createElement(StatusBarMenu, { point: { x: 12, y: 30, origin: element }, close })));
	const choices = [...document.querySelectorAll('[role="menuitemcheckbox"]')];
	expect(choices.map(choice => [choice.textContent, choice.getAttribute("aria-checked"), choice.hasAttribute("data-disabled")])).toEqual([
		["Git branch", "true", false], ["Context use", "false", false], ["omp status", "true", true], ["App update notice", "true", true],
	]);
	await act(async () => choices[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	expect(fake.save).toHaveBeenLastCalledWith({ statusBar: { hidden: [], order: [] } });
	expect(document.querySelector('[role="menu"]')).not.toBeNull();
	await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	expect(close).toHaveBeenCalledOnce();
	expect(document.activeElement).toBe(element);
});
