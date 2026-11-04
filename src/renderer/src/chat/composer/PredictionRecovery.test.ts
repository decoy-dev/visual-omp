// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionController } from "../../state/session";
import "../../i18n";
import { PredictionRecovery, usePredictionCaptures } from "./PredictionRecovery";

const fake = vi.hoisted(() => ({ openTerminal: vi.fn(), invoke: vi.fn() }));
vi.mock("../../state/app", () => ({
	useApp: Object.assign((select: (state: unknown) => unknown) => select({ tabs: [{ id: "tab" }] }), {
		getState: () => ({ openTerminal: fake.openTerminal }),
	}),
}));
vi.mock("../../ui", () => ({
	Button: ({ children, onClick, disabled }: PropsWithChildren<{ onClick: () => void; disabled?: boolean }>) => createElement("button", { onClick, disabled }, children),
	toast: vi.fn(),
}));

let element: HTMLDivElement;
let root: Root;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.openTerminal.mockReset();
	fake.invoke.mockReset().mockResolvedValue([]);
	Object.assign(window, { vomp: { invoke: fake.invoke, on: () => () => {} } });
	usePredictionCaptures.setState({ captures: [] });
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	element.remove();
	usePredictionCaptures.setState({ captures: [] });
});

it.each(["tsp", "classic"] as const)("opens the correct %s recovery screen without exposing the hidden escape", async transport => {
	const capture = { id: "capture", hostId: "host", generation: 1, tabId: "tab", folder: "/project", text: null, blocked: true, error: null };
	fake.invoke.mockResolvedValue([capture]);
	usePredictionCaptures.setState({ captures: [capture] });
	const session = { tabId: "tab", hostId: "host", getSnapshot: () => ({ host: { transport } }) } as unknown as SessionController;
	await act(async () => root.render(createElement(PredictionRecovery, { session, readOnly: false })));
	const label = transport === "tsp" ? "Open omp screen" : "Open omp terminal";
	const button = [...element.querySelectorAll("button")].find(candidate => candidate.textContent === label);
	expect(button).toBeDefined();
	expect(element.textContent).not.toContain("VOMP_TSP");
	expect(element.textContent).not.toContain("preview");
	await act(async () => button!.click());
	expect(fake.openTerminal).toHaveBeenCalledExactlyOnceWith("tab");
});

it("restores complete saved batches, strips extra fields and rejects the whole damaged batch", () => {
	const merge = usePredictionCaptures.persist.getOptions().merge!;
	const current = usePredictionCaptures.getState();
	const capture = { id: "capture", hostId: "host", generation: 1.5, tabId: "tab", folder: "/project", text: "saved", blocked: false, error: null };
	expect(merge({ captures: [{ ...capture, extra: "ignored" }] }, current)).toMatchObject({ captures: [capture] });
	expect((merge({ captures: [{ ...capture, extra: "ignored" }] }, current) as typeof current).captures[0]).not.toHaveProperty("extra");
	for (const damaged of [null, {}, { ...capture, text: undefined }, { ...capture, generation: NaN }, { ...capture, generation: Infinity }, { ...capture, error: 1 }]) {
		expect(merge({ captures: [capture, damaged] }, current)).toMatchObject({ captures: [] });
	}
	expect(merge({ captures: "damaged" }, current)).toMatchObject({ captures: [] });
});
