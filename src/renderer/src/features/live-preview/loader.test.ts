// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppPreferences } from "@shared/ipc";
import type * as Loader from "./loader";
import type * as App from "../../state/app";
import shell from "../../i18n/en/shell.json";

vi.mock("../../registry/idle", () => ({ preloadWhenIdle: () => {} }));
// Tracker retry tests do not render full-page chrome or the icon catalog.
vi.mock("@phosphor-icons/react", () => ({ Warning: () => null }));
vi.mock("../../ui/Page", () => ({
	PageFrame: ({ children }: { children?: ReactNode }) => createElement("main", null, children),
	PageSkeleton: () => null,
}));
vi.mock("../../i18n", () => ({ retryFailedNamespaces: async () => {} }));
vi.mock("../../state/app", async () => {
	const { create } = await import("zustand");
	return { useApp: create(() => ({ prefs: { livePreview: true } })) };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => {
	let value: unknown = shell;
	for (const part of key.split(".")) value = (value as Record<string, unknown>)?.[part];
	return String(value ?? key);
} }) }));
vi.mock("../../ui", () => ({
	Button: ({ children, size: _size, ...props }: { children?: ReactNode; size?: string }) => createElement("button", props, children),
	Notice: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => createElement("div", { role: "status" }, children, actions),
}));

let container: HTMLDivElement;
let root: Root;
let loader: typeof Loader;
let app: typeof App;
const load = vi.fn();

beforeEach(async () => {
	vi.resetModules();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	load.mockReset().mockImplementation(() => { throw new Error("Tracker chunk unavailable"); });
	// The mock import fails until the simulated chunk becomes available.
	vi.doMock("./Tracker", () => { load(); return { Tracker: () => createElement("output", null, "Tracker running") }; });
	loader = await import("./loader");
	app = await import("../../state/app");
	app.useApp.setState({ prefs: { livePreview: true } as AppPreferences });
	container = document.createElement("div"); document.body.append(container);
	root = createRoot(container);
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

async function settle() {
	await act(async () => { await vi.dynamicImportSettled(); });
}
async function render() {
	await act(async () => root.render(createElement("main", null, createElement(loader.TrackerHost), createElement(loader.TrackerLoadNotice))));
	await settle();
}
function makeChunkAvailable() {
	load.mockClear();
	load.mockImplementation(() => {});
	vi.doMock("./Tracker", () => { load(); return { Tracker: () => createElement("output", null, "Tracker running") }; });
}

it("offers Try again in Outputs and restores the tracker after a failed import", async () => {
	await render();
	expect(container.textContent).toContain(shell.load.failedTitle);
	expect(container.querySelector("output")).toBeNull();
	makeChunkAvailable();
	await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
	await settle();
	expect(load).toHaveBeenCalledOnce();
	expect(container.querySelector("output")?.textContent).toBe("Tracker running");
	expect(container.textContent).not.toContain(shell.load.failedTitle);
});

it("retries a failed tracker when previews are turned off and on", async () => {
	await render();
	expect(container.textContent).toContain(shell.load.retry);
	await act(async () => app.useApp.setState({ prefs: { livePreview: false } as AppPreferences }));
	expect(container.textContent).toBe("");
	makeChunkAvailable();
	await act(async () => app.useApp.setState({ prefs: { livePreview: true } as AppPreferences }));
	await settle();
	expect(load).toHaveBeenCalledOnce();
	expect(container.querySelector("output")?.textContent).toBe("Tracker running");
	expect(container.querySelector("button")).toBeNull();
});
