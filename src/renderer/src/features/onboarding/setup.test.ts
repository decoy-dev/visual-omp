// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPreferences, OmpStatus } from "@shared/ipc";
import type { ModelInfo } from "@shared/contracts/config";
import type { ConnectedProvider } from "@shared/contracts/providers";
import { useApp } from "../../state/app";
import { SetupWizard } from "./SetupWizard";
import { finishSetup, needsSetup, setupSteps, startSetup, useSetup } from "./setup";
import "../../i18n";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), setPrefs: vi.fn(), closeSheet: vi.fn(), setPaletteOpen: vi.fn(), connected: false, models: [] as ModelInfo[], installed: false, approval: { mode: "yolo", modeSource: "default" } as { mode: string; modeSource: string } }));
vi.mock("../../state/app", async () => {
	// vi.mock factories run before static imports, so this import must stay inside the factory.
	const { create } = await import("zustand");
	return { useApp: create(() => ({ prefs: null, omp: null, setPrefs: fake.setPrefs, closeSheet: fake.closeSheet, setPaletteOpen: fake.setPaletteOpen })) };
});
vi.mock("../../state/leaveGuard", () => ({ whenLeaving: async (run: () => unknown) => ({ left: true, value: run() }) }));
vi.mock("../manage/settings/OmpLoginDialog", () => ({ OmpLoginDialog: ({ onClose, onFinished }: { onClose(): void; onFinished(code: number): void }) => createElement("button", { onClick: () => { fake.connected = true; onFinished(0); onClose(); } }, "Finish sign-in") }));
vi.mock("./SetupScreen", () => ({ SetupScreen: ({ onReady }: { onReady(): void }) => createElement("button", { onClick: () => { fake.installed = true; onReady(); } }, "Install omp") }));
vi.mock("../../ui", () => {
	const e = createElement;
	return {
		Button: ({ children, onClick, disabled, loading }: PropsWithChildren<{ onClick?: () => void; disabled?: boolean; loading?: boolean }>) => e("button", { disabled: disabled || loading, onClick }, children),
		Mark: () => null, Spinner: () => null,
		cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
		PresenceSwap: ({ children }: PropsWithChildren) => e("div", null, children),
		Notice: ({ children, actions }: PropsWithChildren<{ actions?: ReactNode }>) => e("aside", { role: "alert" }, children, actions),
		SearchInput: ({ value, onValueChange, ...props }: { value: string; onValueChange(value: string): void }) => e("input", { ...props, value, onChange: (event: { currentTarget: HTMLInputElement }) => onValueChange(event.currentTarget.value) }),
	};
});

const ready: OmpStatus = { found: true, supported: true, path: "/bin/omp", version: "18.14.0", minVersion: "18.14.0", installCommand: "never-run", problem: null, refused: false };
const missing: OmpStatus = { ...ready, found: false, supported: false, path: null, version: null };
const model: ModelInfo = { selector: "test/chat", provider: "test", id: "chat", name: "Test chat", kind: "chat", contextWindow: 200000, maxOutputTokens: null, reasoning: false, thinkingLevels: [], vision: false, cost: null };
const provider: ConnectedProvider = {
	id: "test", name: "Test provider", login: { id: "test", name: "Test provider" },
	accounts: [], disabledAccounts: [], authenticated: true, modelCount: 1, kinds: ["chat"], canSignOut: true,
};
const prefs = { setupCompleted: false, theme: "light" } as AppPreferences;
let root: Root;
let element: HTMLDivElement;
const button = (name: string) => [...element.querySelectorAll("button")].find(node => node.textContent === name)!;
const click = async (name: string) => { await act(async () => button(name).click()); };
const render = async () => { await act(async () => root.render(createElement(SetupWizard))); };

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.invoke.mockReset(); fake.setPrefs.mockReset(); fake.closeSheet.mockReset(); fake.setPaletteOpen.mockReset();
	fake.connected = false; fake.models = [model]; fake.installed = false; fake.approval = { mode: "yolo", modeSource: "default" };
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "providers:list") return { connected: fake.connected ? [provider] : [], available: fake.connected ? [] : [{ id: "test", name: "Test provider" }] };
		if (channel === "config:models:refresh") return fake.models;
		if (channel === "config:roles") return { roles: [{ id: "default", model: "test/chat", thinking: "high" }] };
		if (channel === "config:approval") return fake.approval;
		return {};
	});
	fake.setPrefs.mockImplementation(async (patch: Partial<AppPreferences>) => useApp.setState({ prefs: { ...useApp.getState().prefs!, ...patch } }));
	useApp.setState({ prefs: { ...prefs }, omp: ready });
	useSetup.setState({ requested: false, dismissed: false });
	Object.assign(window, { vomp: { invoke: fake.invoke, platform: "darwin" } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

describe("setup visibility and routing", () => {
	it("opens for fresh profiles and missing, old or refused omp, but leaves existing ready profiles alone", () => {
		expect(needsSetup(ready, { setupCompleted: false }, false, false)).toBe(true);
		expect(needsSetup(ready, { setupCompleted: true }, false, false)).toBe(false);
		for (const omp of [missing, { ...ready, supported: false }, { ...ready, refused: true }]) expect(needsSetup(omp, { setupCompleted: true }, false, false)).toBe(true);
		expect(needsSetup(null, prefs, false, false)).toBe(false);
		expect(needsSetup(ready, null, false, false)).toBe(false);
		expect(needsSetup(missing, prefs, false, true)).toBe(false);
	});
	it("skips installation when omp is ready and keeps recovery to one step", () => {
		expect(setupSteps(false, false)).toEqual(["welcome", "providers", "model", "permission", "appearance", "done"]);
		expect(setupSteps(true, false)).toEqual(["welcome", "install", "providers", "model", "permission", "appearance", "done"]);
		expect(setupSteps(true, true)).toEqual(["install"]);
	});
	it("offers full setup again from the replay action", async () => {
		useApp.setState({ prefs: { ...prefs, setupCompleted: true } });
		startSetup();
		expect(useSetup.getState()).toEqual({ requested: true, dismissed: false });
		expect(fake.closeSheet).toHaveBeenCalledOnce();
		expect(needsSetup(ready, useApp.getState().prefs, true, false)).toBe(true);
		await render();
		expect(element.querySelector("h1")?.textContent).toBe("Welcome to visual-omp");
	});
	it("starts existing users at installation and ends after it", async () => {
		useApp.setState({ prefs: { ...prefs, setupCompleted: true }, omp: missing });
		await render(); await click("Install omp");
		expect(fake.installed).toBe(true);
		expect(fake.setPrefs).toHaveBeenCalledWith({ setupCompleted: true });
		expect(useSetup.getState().dismissed).toBe(true);
	});
});

it("uses Skip until connected, refreshes after sign-in and saves the global default and permission", async () => {
	await render(); await click("Start setup");
	expect(button("Skip")).toBeDefined();
	await click("Test provider"); await click("Finish sign-in");
	expect(button("Continue")).toBeDefined();
	expect(fake.invoke.mock.calls.filter(call => call[0] === "providers:list")).toHaveLength(3);
	await click("Continue");
	expect((element.querySelector('input[name="setup-model"]') as HTMLInputElement).checked).toBe(true);
	expect(document.activeElement?.id).toBe("setup-model-title");
	await click("Continue");
	expect(fake.invoke).toHaveBeenCalledWith("config:roles:set", "default", { model: "test/chat", thinking: "high" }, { scope: "global" });
	expect((element.querySelector('input[value="always-ask"]') as HTMLInputElement).checked).toBe(true);
	await click("Continue");
	expect(fake.invoke).toHaveBeenCalledWith("config:approval:setMode", "always-ask", "global");
	await act(async () => (element.querySelector('input[value="dark"]') as HTMLInputElement).click());
	expect(fake.setPrefs).toHaveBeenCalledWith({ theme: "dark" });
	await click("Continue");
	expect(element.querySelector("h1")?.textContent).toBe("You're all set");
	expect(element.textContent).toContain("Test provider");
	expect(element.textContent).toContain("Test chat");
	await click("Start chatting");
	expect(fake.setPrefs).toHaveBeenCalledWith({ setupCompleted: true });
	expect(useSetup.getState().dismissed).toBe(true);
});

it("offers sign-in and Skip when no models are available without writing a model", async () => {
	fake.models = [];
	await render(); await click("Start setup"); await click("Skip");
	expect(element.textContent).toContain("No models yet");
	expect(button("Back to sign in")).toBeDefined();
	await click("Skip");
	expect(element.querySelector("h1")?.textContent).toBe("Choose your permission mode");
	expect(fake.invoke.mock.calls.some(call => call[0] === "config:roles:set")).toBe(false);
});

it("keeps the model step and error visible after a failed save", async () => {
	await render(); await click("Start setup"); await click("Skip");
	fake.invoke.mockRejectedValueOnce(new Error("Could not save model"));
	await click("Continue");
	expect(element.querySelector("h1")?.textContent).toBe("Choose your default model");
	expect(element.querySelector('[role="alert"]')?.textContent).toContain("Could not save model");
});

it.each(["Exit setup", "Escape"])("marks setup completed when leaving with %s", async action => {
	await render();
	if (action === "Escape") await act(async () => element.querySelector("main")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	else await click(action);
	expect(fake.setPrefs).toHaveBeenCalledWith({ setupCompleted: true });
	expect(useSetup.getState()).toEqual({ requested: false, dismissed: true });
});

it("does not dismiss setup when completion persistence fails", async () => {
	fake.setPrefs.mockRejectedValueOnce(new Error("Preferences unavailable"));
	await expect(finishSetup()).rejects.toThrow("Preferences unavailable");
	expect(useSetup.getState().dismissed).toBe(false);
});

it("keeps the remaining first-run steps after installing a missing omp", async () => {
	useApp.setState({ omp: missing });
	await render();
	await click("Start setup");
	await click("Install omp");
	expect(element.querySelector("h1")?.textContent).toBe("Sign in to your providers");
	expect(fake.setPrefs).not.toHaveBeenCalled();
});

it("uses Enter for the primary action after focusing each step title", async () => {
	await render();
	await act(async () => element.querySelector("h1")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
	expect(element.querySelector("h1")?.textContent).toBe("Sign in to your providers");
	expect(document.activeElement?.id).toBe("setup-providers-title");
});

it("writes a different permission mode globally after explicit selection", async () => {
	await render(); await click("Start setup"); await click("Skip"); await click("Continue");
	await act(async () => (element.querySelector('input[value="always-ask-cached"]') as HTMLInputElement).click());
	await click("Continue");
	expect(fake.invoke).toHaveBeenCalledWith("config:approval:setMode", "always-ask-cached", "global");
});

it("keeps a permission mode the user already chose and does not rewrite it", async () => {
	fake.approval = { mode: "yolo", modeSource: "global" };
	await render(); await click("Start setup"); await click("Skip"); await click("Continue");
	expect((element.querySelector('input[value="yolo"]') as HTMLInputElement).checked).toBe(true);
	await click("Continue");
	expect(fake.invoke.mock.calls.some(call => call[0] === "config:approval:setMode")).toBe(false);
});

it("blocks Continue when omp reports a permission mode the app does not recognize", async () => {
	fake.approval = { mode: null as unknown as string, modeSource: "global" };
	await render(); await click("Start setup"); await click("Skip"); await click("Continue");
	expect(element.textContent).toContain("does not recognize");
	await click("Continue");
	await act(async () => element.querySelector("h1")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
	expect(fake.invoke.mock.calls.some(call => call[0] === "config:approval:setMode")).toBe(false);
});

it("skips the completed install when returning from providers through Welcome", async () => {
	useApp.setState({ omp: missing });
	await render(); await click("Start setup"); await click("Install omp");
	await act(async () => useApp.setState({ omp: ready }));
	await click("Back");
	expect(element.querySelector("h1")?.textContent).toBe("Welcome to visual-omp");
	await click("Start setup");
	expect(element.querySelector("h1")?.textContent).toBe("Sign in to your providers");
	expect(button("Install omp")).toBeUndefined();
});

it("describes skipped provider and model configuration honestly in the summary", async () => {
	fake.models = [];
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "providers:list") return { connected: [], available: [] };
		if (channel === "config:models:refresh") return [];
		if (channel === "config:roles") return { roles: [] };
		if (channel === "config:approval") return fake.approval;
		return {};
	});
	await render(); await click("Start setup"); await click("Skip"); await click("Skip");
	await click("Continue"); await click("Continue");
	expect(element.textContent).toContain("No providers connected");
	expect(element.textContent).toContain("No default model configured");
	expect(element.textContent).not.toContain("Chosen by omp");
	expect(element.textContent).not.toContain("Start chatting when you're ready.");
});

it("shows Continue immediately when a provider is already connected", async () => {
	fake.connected = true;
	await render(); await click("Start setup");
	expect(button("Continue")).toBeDefined();
	expect(button("Skip")).toBeUndefined();
});

it("keeps discovery failures blocked for Enter and recovers through Try again", async () => {
	await render(); await click("Start setup");
	fake.invoke.mockRejectedValueOnce(new Error("Model discovery unavailable"));
	await click("Skip");
	expect(element.querySelector('[role="alert"]')?.textContent).toContain("Model discovery unavailable");
	expect(button("Skip").disabled).toBe(true);
	await act(async () => element.querySelector("h1")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
	expect(element.querySelector("h1")?.textContent).toBe("Choose your default model");
	expect(fake.invoke.mock.calls.some(call => call[0] === "config:roles:set")).toBe(false);
	await click("Try again");
	expect(button("Continue").disabled).toBe(false);
	await click("Continue");
	expect(element.querySelector("h1")?.textContent).toBe("Choose your permission mode");
});

it("ignores late provider refreshes after a newer refresh and model discovery take ownership", async () => {
	const earlier = Promise.withResolvers<unknown>();
	const latest = Promise.withResolvers<unknown>();
	const discovery = Promise.withResolvers<ModelInfo[]>();
	const original = fake.invoke.getMockImplementation()!;
	let providerReads = 0;
	fake.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
		if (channel === "providers:list") {
			providerReads += 1;
			if (providerReads === 2) return earlier.promise;
			if (providerReads === 3) return latest.promise;
		}
		if (channel === "config:models:refresh") return discovery.promise;
		return original(channel, ...args);
	});
	await render(); await click("Start setup"); await click("Test provider"); await click("Finish sign-in");
	expect(button("Skip").disabled).toBe(true);
	await act(async () => latest.resolve({ connected: [provider], available: [] }));
	await click("Continue");
	expect(button("Skip").disabled).toBe(true);
	await act(async () => earlier.reject(new Error("Stale provider failure")));
	expect(element.querySelector('[role="alert"]')).toBeNull();
	expect(button("Skip").disabled).toBe(true);
	await act(async () => discovery.resolve([model]));
	expect(button("Continue").disabled).toBe(false);
	expect(element.querySelector("h1")?.textContent).toBe("Choose your default model");
});

it("keeps disabled-only providers available for sign-in without counting them as connected", async () => {
	const disabled: ConnectedProvider = {
		...provider, authenticated: false, modelCount: 0, accounts: [],
		disabledAccounts: [{ email: "expired@example.test", accountId: null, cause: "Expired", disabledAt: null }],
	};
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "providers:list") return { connected: [disabled], available: [] };
		if (channel === "config:models:refresh") return [];
		if (channel === "config:roles") return { roles: [] };
		if (channel === "config:approval") return fake.approval;
		return {};
	});
	await render(); await click("Start setup");
	expect(element.textContent).toContain("Needs sign-in");
	expect(button("Skip")).toBeDefined();
	expect(button("Continue")).toBeUndefined();
	expect(button("Test providerNeeds sign-in").disabled).toBe(false);
	await click("Skip"); await click("Skip"); await click("Continue"); await click("Continue");
	expect(element.textContent).toContain("No providers connected");
	expect(element.querySelector("dd")?.textContent).not.toContain("Test provider");
});
