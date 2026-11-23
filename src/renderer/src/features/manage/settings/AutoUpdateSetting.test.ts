// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import { SetupAutoUpdateSetting } from "./AutoUpdateSetting";
const invoke = vi.fn();
let root: Root;
let element: HTMLDivElement;
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	await i18n.loadNamespaces("settings");
	invoke.mockReset();
	Object.assign(window, { vomp: { invoke } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
it("omits the opt-in when an older omp does not report it", async () => {
	invoke.mockResolvedValue({ settings: [] });
	await act(async () => root.render(createElement(SetupAutoUpdateSetting)));
	expect(element.querySelector('[role="switch"]')).toBeNull();
});
it("shows the opt-in's label and help with a placeholder until omp reports the setting", async () => {
	const list = Promise.withResolvers<unknown>();
	invoke.mockImplementation((channel: string) => channel === "config:list" ? list.promise : Promise.resolve(undefined));
	await act(async () => root.render(createElement(SetupAutoUpdateSetting)));
	expect(element.textContent).toContain("Update omp automatically");
	expect(element.querySelector('[role="switch"]')).toBeNull();
	expect(element.querySelector('[aria-busy="true"]')).not.toBeNull();
	await act(async () => list.resolve({ settings: [{ key: "update.auto", value: true }] }));
	expect(element.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
	expect(element.querySelector('[aria-busy="true"]')).toBeNull();
});
it("uses omp's saved value and global settings write in setup", async () => {
	const setting = { key: "update.auto", value: false };
	invoke.mockImplementation(async (channel: string) => channel === "config:list" ? { settings: [setting] } : { setting: { ...setting, value: true }, shadowedBy: null });
	await act(async () => root.render(createElement(SetupAutoUpdateSetting)));
	const control = element.querySelector<HTMLButtonElement>('[role="switch"]')!;
	expect(control.getAttribute("aria-checked")).toBe("false");
	expect(element.textContent).toContain("through your install method");
	await act(async () => control.click());
	expect(invoke).toHaveBeenCalledWith("config:set", "update.auto", true, "global", undefined);
	expect(control.getAttribute("aria-checked")).toBe("true");
});
