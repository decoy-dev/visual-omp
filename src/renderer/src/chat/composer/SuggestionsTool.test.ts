// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SettingInfo } from "@shared/contracts/config";
import type { SessionController, SessionView } from "../../state/session";
import { TooltipProvider } from "../../ui/Tooltip";
import { SuggestionsTool } from "./SuggestionsTool";
import "../../i18n";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../ui/toast", () => ({ toast: fake.toast }));
let container: HTMLDivElement; let root: Root; let setting: SettingInfo;
let changed: ((event: { scope: string; cwd: string | null }) => void) | undefined;
let view: SessionView;
const session = { projectPath: "/fixture/project", subscribe: () => () => {}, getSnapshot: () => view } as unknown as SessionController;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	setting = { key: "composer.predictions", type: "boolean", value: false, defaultValue: false, source: "default", globalValue: null, projectValue: null } as SettingInfo;
	view = { readOnly: false, host: { transport: "tsp" } } as SessionView;
	fake.invoke.mockReset().mockImplementation(async (channel: string, ...args: unknown[]) => {
		if (channel === "config:get") return { ...setting };
		if (channel === "config:set") { setting = { ...setting, source: "global", value: args[1] as boolean, globalValue: args[1] as boolean }; return { setting, shadowedBy: null }; }
	});
	Object.assign(window, { vomp: { invoke: fake.invoke, on: (_channel: string, callback: typeof changed) => { changed = callback; return () => { changed = undefined; }; } } });
	container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const mount = () => act(async () => root.render(createElement(TooltipProvider, null, createElement(SuggestionsTool, { session }))));
const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;

it.each(["classic", "tsp"])("keeps omp's off default and saves both choices through its global settings (%s)", async transport => {
	view = { ...view, host: { transport } } as SessionView;
	await mount();
	expect(toggle().getAttribute("aria-label")).toBe("Suggestions: predict my next message");
	expect(toggle().getAttribute("aria-checked")).toBe("false");
	expect(toggle().textContent).toBe("SuggestionsOff");
	await act(async () => toggle().click());
	expect(fake.invoke).toHaveBeenCalledWith("config:set", "composer.predictions", true, "global", "/fixture/project");
	expect(toggle().getAttribute("aria-checked")).toBe("true");
	await act(async () => toggle().click());
	expect(fake.invoke).toHaveBeenCalledWith("config:set", "composer.predictions", false, "global", "/fixture/project");
	expect(toggle().getAttribute("aria-checked")).toBe("false");
});
it.each([true, false])("keeps the explicit user value %s", async value => {
	setting = { ...setting, source: "global", value, globalValue: value };
	await mount(); expect(toggle().getAttribute("aria-checked")).toBe(String(value));
});
it("explains project control without writing a config file in the project", async () => {
	setting = { ...setting, source: "project", value: false, projectValue: false };
	await mount();
	expect(toggle().getAttribute("aria-checked")).toBe("false");
	expect(toggle().getAttribute("aria-disabled")).toBe("true");
	expect(toggle().getAttribute("aria-description")).toContain("project's setting");
	await act(async () => toggle().click());
	expect(fake.invoke.mock.calls.some(call => call[0] === "config:set")).toBe(false);
});
it("refreshes from omp when Settings changes and explains the extra model request", async () => {
	await mount();
	setting = { ...setting, source: "global", value: true };
	await act(async () => changed?.({ scope: "global", cwd: null }));
	expect(toggle().getAttribute("aria-checked")).toBe("true");
	expect(toggle().getAttribute("aria-description")).toContain("extra model request after replies; this counts toward usage");
	expect(toggle().getAttribute("aria-description")).not.toContain("smol");
});
it("keeps the last value if saving fails", async () => {
	await mount();
	fake.invoke.mockRejectedValueOnce(new Error("Permission denied"));
	await act(async () => toggle().click());
	expect(toggle().getAttribute("aria-checked")).toBe("false");
});
it("disables read-only chats", async () => { view = { ...view, readOnly: true }; await mount(); expect(toggle().disabled).toBe(true); });
