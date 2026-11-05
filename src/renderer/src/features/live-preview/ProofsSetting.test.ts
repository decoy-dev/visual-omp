// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VisualProofsStatus } from "@shared/contracts/skills";

const env = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, () => void>() }));
vi.mock("../../state/app", async () => {
	// Vitest hoists this mock factory before static imports are initialized.
	const { create } = await import("zustand");
	return { useApp: create(() => ({ prefs: { visualProofs: false } })) };
});
vi.mock("../../i18n", () => ({ useDeferredTranslation: () => ({ t: (key: string, values?: { path: string }) => key + (values?.path ?? "") }) }));
vi.mock("../../ui", () => ({
	Button: ({ children, variant: _variant, size: _size, ...props }: { children?: ReactNode; variant?: string; size?: string }) => createElement("button", props, children),
	Switch: ({ label, description, checked, disabled, onCheckedChange }: { label: string; description: string; checked: boolean; disabled: boolean; onCheckedChange(value: boolean): void }) => createElement("div", null, description, createElement("button", { role: "switch", "aria-label": label, "aria-checked": checked, disabled, onClick: () => onCheckedChange(!checked) }, label)),
}));
import { useApp } from "../../state/app";
import { ProofsSetting } from "./ProofsSetting";
let element: HTMLDivElement;
let root: Root;
let status: VisualProofsStatus;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	status = { state: "off" };
	env.invoke.mockReset().mockImplementation(async (channel: string, enabled?: boolean) => {
		if (channel === "proofs:set") { status = { state: enabled ? "on" : "off" }; useApp.setState({ prefs: { visualProofs: enabled! } } as never); }
		return status;
	});
	env.listeners.clear();
	Object.assign(window, { vomp: { invoke: env.invoke, on: (channel: string, listener: () => void) => { env.listeners.set(channel, listener); return () => env.listeners.delete(channel); } } });
	useApp.setState({ prefs: { visualProofs: false } } as never);
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

it("changes the managed skill through proofs:set rather than a preference-only write", async () => {
	await act(async () => root.render(createElement(ProofsSetting)));
	const control = element.querySelector<HTMLButtonElement>('[role="switch"]')!;
	expect(control.getAttribute("aria-checked")).toBe("false");
	await act(async () => control.click());
	expect(env.invoke).toHaveBeenCalledWith("proofs:set", true);
	expect(control.getAttribute("aria-checked")).toBe("true");
	await act(async () => control.click());
	expect(env.invoke).toHaveBeenCalledWith("proofs:set", false);
	expect(control.getAttribute("aria-checked")).toBe("false");
});

it("shows a conflict path, keeps the switch off and refreshes after skill changes", async () => {
	status = { state: "conflict", path: "/scratch/skills/visual-proofs/SKILL.md" };
	await act(async () => root.render(createElement(ProofsSetting)));
	expect(element.textContent).toContain(status.path);
	expect(element.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
	status = { state: "off" };
	await act(async () => env.listeners.get("skills:changed")!());
	expect(element.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(false);
});

it("retains the persisted off preference after a personal replacement is moved and settings reopen", async () => {
	useApp.setState({ prefs: { visualProofs: true } } as never);
	status = { state: "on" };
	env.invoke.mockImplementation(async (channel: string) => {
		if (channel === "proofs:status" && status.state === "conflict") {
			// Main persists off and broadcasts app:prefs before returning the conflict.
			useApp.setState({ prefs: { visualProofs: false } } as never);
		}
		return status;
	});
	await act(async () => root.render(createElement(ProofsSetting)));
	expect(element.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
	status = { state: "conflict", path: "/scratch/skills/visual-proofs/SKILL.md" };
	await act(async () => env.listeners.get("skills:changed")!());
	expect(useApp.getState().prefs?.visualProofs).toBe(false);
	expect(element.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
	expect(element.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
	status = { state: "off" };
	await act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === "general.visualProofs.checkAgain")!.click());
	expect(element.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
	await act(async () => root.unmount());
	root = createRoot(element);
	await act(async () => root.render(createElement(ProofsSetting)));
	expect(element.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
	expect(env.invoke.mock.calls.some(([channel]) => channel === "proofs:set")).toBe(false);
});

it("shows failures and allows another attempt without claiming an install succeeded", async () => {
	env.invoke.mockImplementation(async (channel: string) => { if (channel === "proofs:set") throw new Error("Permission denied"); return { state: "off" }; });
	await act(async () => root.render(createElement(ProofsSetting)));
	await act(async () => element.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
	expect(element.querySelector('[role="alert"]')?.textContent).toBe("Permission denied");
	expect(element.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
	expect(element.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(false);
});

it("offers repair for an opted-in missing skill and reports source filters", async () => {
	useApp.setState({ prefs: { visualProofs: true } } as never);
	status = { state: "outdated" };
	await act(async () => root.render(createElement(ProofsSetting)));
	expect(element.textContent).toContain("general.visualProofs.outdated");
	await act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === "general.visualProofs.repair")!.click());
	expect(env.invoke).toHaveBeenCalledWith("proofs:set", true);
	status = { state: "unavailable", reason: "ignored" };
	await act(async () => env.listeners.get("config:changed")!());
	expect(element.textContent).toContain("general.visualProofs.ignored");
});
