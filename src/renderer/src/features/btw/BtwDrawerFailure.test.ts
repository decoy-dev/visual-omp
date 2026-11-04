// @vitest-environment happy-dom
import type { BtwProjection } from "@shared/tsp/btw";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../../i18n";
import { useApp } from "../../state/app";
import type { SessionController, SessionView } from "../../state/session";
import { BtwDrawer, BtwDrawerContent } from "./BtwPane";

const fake = vi.hoisted(() => ({ projection: null as unknown }));

// Idle preloading would load the drawer before the test fails it.
vi.mock("../../registry/idle", () => ({ preloadWhenIdle: () => {} }));
// The drawer's controls and history load from their own chunk; this test makes that chunk fail.
vi.mock("./BtwPaneContent", () => {
	throw new Error("Chunk unavailable");
});
// omp's side question document: present until omp puts it away.
vi.mock("../../state/tsp/useTsp", () => ({
	useTsp: () => ({ snapshot: { hostId: "host", lifecycle: "live", generation: 1, epoch: 1, surfaces: [] }, failed: false, store: null }),
}));
vi.mock("@shared/tsp/btw", async importOriginal => ({ ...(await importOriginal<object>()), projectBtw: () => fake.projection }));

const shell = import.meta.glob<{ load: Record<string, string>; status: Record<string, string> }>("../../i18n/en/shell.json", { eager: true, import: "default" })["../../i18n/en/shell.json"]!;

const projection = {
	surfaceId: "surface", nodeId: "node", selectedId: null, focused: false, list: null, topics: [], actions: {}, field: null, supported: true, notice: null,
	turns: [{ question: "What does the build guard check?", answer: "The size of the startup bundle.", status: "complete" }],
} as unknown as BtwProjection;

const view = { mode: "live", readOnly: false, host: { transport: "tsp", hostId: "host", generation: 1, tspEpoch: 1, phase: "live" } } as unknown as SessionView;
const session = { tabId: "tab", getSnapshot: () => view, subscribe: () => () => {} } as unknown as SessionController;

let element: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	fake.projection = projection;
	// The user asked a side question, so the drawer is explicitly requested.
	useApp.setState({ btwDrawers: { tab: true }, terminalTabId: null });
});

afterEach(() => {
	act(() => root.unmount());
	element.remove();
	useApp.setState({ btwDrawers: {}, terminalTabId: null });
});

const render = () => root.render(createElement(BtwDrawer, { session }));

it("keeps the side question readable when the drawer does not load, and hands it to omp's terminal until omp puts it away", async () => {
	await act(async () => render());
	await act(async () => {
		await BtwDrawerContent.preload().catch(() => {});
	});
	const drawer = element.querySelector("[data-btw-drawer]");
	expect(drawer?.textContent).toContain("What does the build guard check?");
	expect(drawer?.textContent).toContain("The size of the startup bundle.");
	expect(drawer?.textContent).toContain(shell.load.failedTitle);
	expect(drawer?.querySelector("[aria-busy]")).toBeNull();

	await act(async () => [...drawer!.querySelectorAll("button")].find(button => button.textContent === shell.status.openTerminal)!.click());
	expect(useApp.getState().terminalTabId).toBe("tab");
	// omp still presents the question, so the drawer stays.
	expect(element.querySelector("[data-btw-drawer]")).not.toBeNull();

	// omp puts the question away in its own screen.
	fake.projection = null;
	await act(async () => render());
	expect(element.querySelector("[data-btw-drawer]")).toBeNull();
});
