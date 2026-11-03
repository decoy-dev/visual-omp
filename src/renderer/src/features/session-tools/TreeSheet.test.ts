// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { TSP_ROLES } from "@shared/tsp/roles";
import "../../i18n";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { parseSessionTree } from "./tree";
import { TreeSheet } from "./TreeSheet";
import { presentationClaims } from "../../state/tsp/presentation-claims";

const fake = vi.hoisted(() => ({ transport: "classic" as "classic" | "tsp", hostId: "host", generation: 1, snapshot: null as TspHostSnapshot | null, toast: vi.fn(), open: vi.fn(), command: vi.fn(), answer: vi.fn(), navigate: vi.fn(), load: vi.fn() }));
const controller = { tabId: "tab", command: fake.command, answer: fake.answer, getSnapshot: () => ({ mode: "live", host: { hostId: fake.hostId, generation: fake.generation, transport: fake.transport } }) };
vi.mock("../../state/app", () => ({ controllerFor: () => controller, useApp: { getState: () => ({ openTerminal: fake.open }) } }));
vi.mock("../../shell/hooks", () => ({ useSessionView: () => controller.getSnapshot() }));
vi.mock("../../state/tsp/useTsp", () => ({ useTsp: () => ({ snapshot: fake.snapshot }) }));
vi.mock("./navigate", () => ({ loadTree: (...args: unknown[]) => fake.load(...args), navigateTo: (...args: unknown[]) => fake.navigate(...args), forkChat: vi.fn() }));
vi.mock("../../transcript/Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("p", null, text) }));
vi.mock("@/ui", () => ({
	Button: ({ children, onClick, disabled }: PropsWithChildren<{ onClick(): void; disabled?: boolean }>) => createElement("button", { onClick, disabled }, children),
	Expand: ({ open, children }: PropsWithChildren<{ open: boolean }>) => open ? children : null,
	PresenceSwap: ({ children }: PropsWithChildren) => children, Mark: () => null, EmptyState: () => null,
	cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "), spring: { snappy: {} }, toast: (...args: unknown[]) => fake.toast(...args),
}));
const originalSetDraft = useComposerDrafts.getState().setDraft;
let root: Root; let element: HTMLDivElement;
function treeSnapshot(): TspHostSnapshot {
	return {
		hostId: "host", generation: 1, epoch: 2, revision: 1, negotiated: true, lifecycle: "live",
		documentGeneration: 1, availability: { available: false, reason: "Tree open" }, failure: null,
		surfaces: [{
			open: { id: "surface", mode: "inline" }, sequence: 1, closed: false, suspended: false,
			documentGeneration: 1, focus: "tree-selector", settled: [],
			document: { id: "tree-selector", k: "list", p: { role: TSP_ROLES.treeSelector } },
		}],
	};
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.transport = "classic";
	fake.hostId = "host"; fake.generation = 1; fake.snapshot = null;
	fake.toast.mockReset(); fake.open.mockReset(); fake.command.mockReset(); fake.answer.mockReset(); fake.navigate.mockReset().mockRejectedValue(new Error("Navigation unavailable"));
	useComposerDrafts.setState({ drafts: { tab: "Existing app draft" }, previews: {}, editorRestores: {}, setDraft: originalSetDraft });
	fake.load.mockResolvedValue(parseSessionTree(JSON.stringify({ id: "user", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "A recorded prompt" } })));
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); });

it.each(["user", "assistant"] as const)("navigates to the selected TSP %s entry without assigning the app draft", async role => {
	fake.transport = "tsp";
	fake.snapshot = treeSnapshot();
	const exactDraft = "  Selected user prompt café | https://example.com/long/path\n\n  Keep these spaces.  \n";
	fake.load.mockResolvedValue(parseSessionTree([
		{ id: "entry-user-target", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: exactDraft } },
		{ id: "entry-assistant-target", parentId: "entry-user-target", type: "message", timestamp: "2026-01-01T00:01:00Z", message: { role: "assistant", content: "Selected assistant reply" } },
	].map(entry => JSON.stringify(entry)).join("\n")));
	const navigation = Promise.withResolvers<{ draft: string | null }>();
	fake.navigate.mockReturnValue(navigation.promise);
	const setDraft = vi.spyOn(useComposerDrafts.getState(), "setDraft");
	const close = vi.fn();
	await act(async () => root.render(createElement(TreeSheet, { props: { tabId: "tab", entryId: role === "user" ? "entry-assistant-target" : "entry-user-target" }, close })));
	const target = [...document.querySelectorAll('[role="treeitem"]')].find(item => item.getAttribute("aria-label")?.includes(`Selected ${role}`))!;
	expect(target).toBeDefined();
	await act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
	const goHere = [...document.querySelectorAll("button")].find(button => button.textContent === (role === "user" ? "Rewind to here" : "Resume from here"))!;
	expect(goHere).toBeDefined();
	expect(goHere.disabled).toBe(false);
	expect(presentationClaims.getSnapshot()).toEqual([]);
	await act(async () => goHere.click());
	expect(fake.navigate).toHaveBeenCalledExactlyOnceWith(controller, `entry-${role}-target`);
	expect(goHere.disabled).toBe(true);
	expect(close).not.toHaveBeenCalled();
	expect(presentationClaims.getSnapshot()).toEqual([{ hostId: "host", epoch: 2, surfaceId: "surface", nodeId: "tree-selector" }]);
	expect(useComposerDrafts.getState().drafts.tab).toBe("Existing app draft");

	await act(async () => {
		if (role === "user") useComposerDrafts.getState().restoreEditor("tab", "tree-transfer", exactDraft);
		navigation.resolve({ draft: role === "user" ? exactDraft : null });
	});
	expect(close).toHaveBeenCalledOnce();
	expect(fake.navigate).toHaveBeenCalledOnce();
	expect(setDraft).not.toHaveBeenCalled();
	expect(useComposerDrafts.getState().drafts.tab).toBe(role === "user" ? `Existing app draft\n${exactDraft}` : "Existing app draft");
	expect(fake.toast).not.toHaveBeenCalled();
	expect(presentationClaims.getSnapshot()).toEqual([]);
});

it.each([
	{ transport: "classic", existing: "selector" },
	{ transport: "tsp", existing: "selector" },
	{ transport: "tsp", existing: "summary question" },
] as const)("keeps the sheet open and preserves the existing $existing after failed $transport navigation", async ({ transport, existing }) => {
	fake.transport = transport;
	fake.snapshot = treeSnapshot();
	if (existing === "summary question") fake.snapshot.surfaces[0]!.document = { id: "summary", k: "picker", p: {
		title: "Summarize branch?", layout: "rows", noun: "options", items: [{ id: "0", label: "No summary" }, { id: "1", label: "Summarize" }],
		actions: [{ id: "confirm", label: "Confirm" }, { id: "close", label: "Close" }],
	} };
	const close = vi.fn();
	await act(async () => root.render(createElement(TreeSheet, { props: { tabId: "tab" }, close })));
	const rewind = [...document.querySelectorAll("button")].find(button => button.textContent === "Rewind to here")!;
	expect(rewind).toBeDefined();
	await act(async () => rewind.click());
	expect(fake.navigate).toHaveBeenCalledExactlyOnceWith(controller, "user");
	expect(close).not.toHaveBeenCalled();
	expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("Navigation unavailable");
	expect(rewind.disabled).toBe(false);
	expect(useComposerDrafts.getState().drafts.tab).toBe("Existing app draft");
	expect(fake.toast).toHaveBeenCalledOnce();
	const action = fake.toast.mock.calls[0][0].action as { label: string; onClick(): void };
	expect(action.label).toBe(transport === "tsp" ? "Open omp screen" : "Open tree in terminal");
	action.onClick();
	if (transport === "tsp") expect(fake.command).not.toHaveBeenCalled();
	else expect(fake.command).toHaveBeenCalledExactlyOnceWith("/tree");
	expect(fake.answer).not.toHaveBeenCalled();
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
	expect(presentationClaims.getSnapshot()).toEqual([]);
});

it.each(["close", "unmount", "host", "generation", "epoch"] as const)("releases the pending tree selector claim on %s", async change => {
	fake.transport = "tsp"; fake.snapshot = treeSnapshot();
	const navigation = Promise.withResolvers<{ draft: string | null }>();
	fake.navigate.mockReturnValue(navigation.promise);
	const close = vi.fn();
	await act(async () => root.render(createElement(TreeSheet, { props: { tabId: "tab" }, close })));
	const rewind = [...document.querySelectorAll("button")].find(button => button.textContent === "Rewind to here")!;
	await act(async () => rewind.click());
	expect(presentationClaims.getSnapshot()).toEqual([{ hostId: "host", epoch: 2, surfaceId: "surface", nodeId: "tree-selector" }]);
	await act(async () => {
		if (change === "close") [...document.querySelectorAll("button")].find(button => button.textContent === "Close")!.click();
		else if (change === "unmount") root.render(null);
		else {
			if (change === "host") fake.hostId = "replacement";
			else if (change === "generation") fake.generation++;
			else fake.snapshot = { ...fake.snapshot!, epoch: 3 };
			root.render(createElement(TreeSheet, { props: { tabId: "tab" }, close }));
		}
	});
	expect(presentationClaims.getSnapshot()).toEqual([]);
	await act(async () => navigation.resolve({ draft: null }));
});
