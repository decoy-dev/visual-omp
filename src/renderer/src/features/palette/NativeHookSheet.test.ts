// @vitest-environment happy-dom
import { act, createElement, Fragment, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../../state/session";
import type { TspHostSnapshot } from "@shared/tsp-host";
import type * as OmpScreenModule from "../tsp/OmpScreenSheet";
import { hookDialogTarget } from "@shared/tsp/dialogs";
import { FixtureDocuments, loadFixtureRecording } from "../tsp/testing/documents";
import { presentationClaims } from "../tsp/presentation-claims";
import { OmpDialogCard } from "../session-tools/OmpDialogCard";
import { useApp } from "../../state/app";
import { TooltipProvider } from "../../ui/Tooltip";
import { TerminalSheet } from "./TerminalSheet";
import "../../i18n";

vi.mock("../../registry/lazy", async () => {
	// Replace only chunk loading; the card, application store, Radix sheet and semantic content are real.
	const { OmpScreenSheet } = await vi.importActual<typeof OmpScreenModule>("../tsp/OmpScreenSheet");
	let count = 0;
	return { lazyView: () => ++count === 1 ? () => null : OmpScreenSheet };
});
vi.mock("motion/react", () => {
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, variants, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { AnimatePresence: ({ children }: PropsWithChildren) => children, MotionConfig: ({ children }: PropsWithChildren) => children, motion: { div: tag("div"), section: tag("section"), span: tag("span"), ul: tag("ul"), li: tag("li") }, useReducedMotionConfig: () => true };
});
let root: Root;
let element: HTMLDivElement;
let session: SessionController;
let invoke: ReturnType<typeof vi.fn>;
function Harness({ card }: { card: boolean }) {
	const open = useApp(state => state.terminalTabId === "fixture");
	return createElement(TooltipProvider, null, createElement(Fragment, null,
		card ? createElement(OmpDialogCard, { session }) : null,
		open ? createElement(TerminalSheet, { tabId: "fixture", controller: session }) : null,
	));
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	useApp.setState({ terminalTabId: null, sheet: null });
	const documents = new FixtureDocuments();
	for (const message of loadFixtureRecording("hook-select").messages) {
		documents.receive({ ...message, body: JSON.stringify(message.body) });
		if (hookDialogTarget(documents.snapshot().surfaces)) break;
	}
	const recorded = documents.snapshot();
	const target = hookDialogTarget(recorded.surfaces)!;
	const snapshot: TspHostSnapshot = { ...recorded, hostId: "fixture", generation: 1, revision: 1, lifecycle: "live", documentGeneration: 1, availability: { available: false, reason: "Question open" }, failure: null,
		questionMatches: [{ surfaceId: target.surface.open.id, nodeId: target.node.id, status: "unmatched" }], surfaces: recorded.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
	const view = { mode: "live", readOnly: false, host: { hostId: "fixture", transport: "tsp", generation: 1, phase: "live", cols: 110, rows: 32, tui: { overlays: 1, focused: "picker", overlayKinds: ["picker"] } } } as unknown as SessionView;
	session = { tabId: "fixture", hostId: "fixture", subscribe: () => () => {}, getSnapshot: () => view, ensureLive: async () => {}, restart: async () => {} } as unknown as SessionController;
	invoke = vi.fn(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke, on: () => () => {} } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); useApp.setState({ terminalTabId: null, sheet: null }); element.remove(); Reflect.deleteProperty(window, "vomp"); });
it("opens the actual omp sheet over an actual native card and closes it on Escape without answering the hook", async () => {
	await act(async () => root.render(createElement(Harness, { card: true })));
	expect(presentationClaims.getSnapshot()).toHaveLength(1);
	await act(async () => useApp.getState().openTerminal("fixture"));
	const screen = document.querySelector<HTMLElement>('[role="region"][aria-label="omp screen"]')!;
	expect(screen).not.toBeNull();
	expect(presentationClaims.getSnapshot()).toHaveLength(0);
	expect(screen.querySelectorAll('[role="option"]')).toHaveLength(4);
	await act(async () => screen.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	expect(useApp.getState().terminalTabId).toBeNull();
	expect(invoke.mock.calls.some(call => ["host:keys", "host:tsp-answer"].includes(String(call[0])))).toBe(false);
	expect(presentationClaims.getSnapshot()).toHaveLength(1);
	expect(element.querySelectorAll('[role="radio"]')).toHaveLength(4);
});
it("retains guarded generic Escape cancellation when no native card is available", async () => {
	await act(async () => root.render(createElement(Harness, { card: false })));
	await act(async () => useApp.getState().openTerminal("fixture"));
	const screen = document.querySelector<HTMLElement>('[role="region"][aria-label="omp screen"]')!;
	expect(screen.querySelectorAll('[role="option"]')).toHaveLength(4);
	await act(async () => screen.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	expect(invoke).toHaveBeenCalledWith("host:keys", "fixture", "escape", 1, 1);
	expect(useApp.getState().terminalTabId).toBe("fixture");
});
