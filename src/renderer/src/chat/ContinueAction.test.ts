// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeSnapshot } from "@shared/contracts/native";
import type { SessionController, SessionView } from "../state/session";
import "../i18n";

const fake = vi.hoisted(() => ({ native: { modes: null, theme: null, ompVersion: "18.18.6", asyncJobsGeneration: 1 } as NativeSnapshot, continueTurn: vi.fn(async () => {}), listeners: new Set<(event: { hostId: string; snapshot: NativeSnapshot }) => void>(), toast: vi.fn() }));
vi.mock("../ui", () => ({
	MenuItem: ({ children, disabled, onSelect }: { children: ReactNode; disabled: boolean; onSelect: () => void }) => createElement("button", { disabled, onClick: onSelect }, children),
	Tooltip: ({ children, content }: { children: ReactNode; content: string }) => createElement("span", { title: content }, children),
	toast: fake.toast,
}));
import { ContinueAction } from "./ContinueAction";
let container: HTMLDivElement;
let root: Root;
let view: SessionView;
let eligible = true;
const subscriptions = new Set<() => void>();
const session = { subscribe: (listener: () => void) => { subscriptions.add(listener); return () => { subscriptions.delete(listener); }; }, getSnapshot: () => view, get canContinue() { return eligible; }, continueTurn: fake.continueTurn } as unknown as SessionController;
const render = async () => { await act(async () => { root.render(createElement(ContinueAction, { session })); }); };
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.assign(window, { vomp: { invoke: vi.fn(async () => fake.native), on: (_channel: string, listener: (event: { hostId: string; snapshot: NativeSnapshot }) => void) => { fake.listeners.add(listener); return () => fake.listeners.delete(listener); } } });
	fake.native = { modes: null, theme: null, ompVersion: "18.18.6", asyncJobsGeneration: 1 };
	fake.continueTurn.mockClear(); fake.toast.mockClear(); fake.listeners.clear(); subscriptions.clear(); eligible = true;
	view = { mode: "live", host: { hostId: "host", generation: 1 } } as SessionView;
	container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it.each(["18.15.0", "18.18.1", undefined])("hides the action for running omp %s", async ompVersion => {
	fake.native = { ...fake.native, ompVersion }; await render(); expect(container.textContent).toBe("");
});
it("shows the label and tooltip, invokes Continue and disables it while pending", async () => {
	const pending = Promise.withResolvers<void>(); fake.continueTurn.mockImplementationOnce(() => pending.promise);
	await render(); const button = container.querySelector("button")!;
	expect(button.textContent).toBe("Continue"); expect(container.querySelector("[title]")?.getAttribute("title")).toContain("interrupting the current reply");
	await act(async () => button.click()); expect(fake.continueTurn).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(true);
	await act(async () => pending.resolve()); expect(button.disabled).toBe(false);
});
it("retains a disabled action when the current turn cannot continue", async () => {
	eligible = false; await render(); expect(container.querySelector("button")?.disabled).toBe(true);
});
it("hides stale generation metadata until the current host reports its version", async () => {
	fake.native = { ...fake.native, asyncJobsGeneration: 0 }; await render(); expect(container.textContent).toBe("");
	await act(async () => { for (const listener of fake.listeners) listener({ hostId: "host", snapshot: { ...fake.native, asyncJobsGeneration: 1 } }); });
	expect(container.querySelector("button")?.textContent).toBe("Continue");
});
it("reports a submission error", async () => {
	fake.continueTurn.mockRejectedValueOnce(new Error("Editor changed")); await render();
	await act(async () => container.querySelector("button")!.click());
	expect(fake.toast).toHaveBeenCalledWith({ tone: "err", message: "Editor changed" });
});
