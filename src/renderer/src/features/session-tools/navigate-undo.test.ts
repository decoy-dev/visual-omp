// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useComposerDrafts } from "../../chat/composer/drafts";
import type { SessionController, SessionEvent, SessionView } from "../../state/session";
import { screenActivity } from "../../state/tsp/screen-activity";
import { clearToasts, dismissToast, useToasts, type ToastRecord } from "../../ui/toast";
import { press, readScreen, readyEditor, waitForScreen } from "./drive";
import { navigateTo } from "./navigate";
import { navigateSemantic } from "./navigateTsp";
import "../../i18n";

vi.mock("../../state/app", () => ({ useApp: {} }));
vi.mock("./navigateTsp", () => ({ navigateSemantic: vi.fn() }));
vi.mock("./drive", () => ({ OmpBusyError: class extends Error {}, press: vi.fn(), readScreen: vi.fn(), readyEditor: vi.fn(), waitForScreen: vi.fn() }));
const seed = [
	{ id: "first", parentId: null, type: "message", message: { role: "assistant", content: "First answer" } },
	{ id: "prompt", parentId: "first", type: "message", message: { role: "user", content: "Earlier prompt" } },
	{ id: "leaf", parentId: "prompt", type: "message", message: { role: "assistant", content: "Old answer" } },
];
let root: Root;
let element: HTMLDivElement;
let latest: readonly ToastRecord[] = [];
let view: SessionView;
let session: SessionController;
const listeners = new Set<() => void>();
const events = new Set<(event: SessionEvent) => void>();
function Reader() { latest = useToasts(); return null; }
function publish() { for (const listener of [...listeners]) listener(); }
function emit(event: SessionEvent) { for (const listener of [...events]) listener(event); }
const invoke = vi.fn();

beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	clearToasts(); listeners.clear(); events.clear(); vi.clearAllMocks();
	localStorage.clear(); useComposerDrafts.setState({ drafts: { chat: "Unfinished draft" }, previews: {}, attachments: {}, editorRestores: {}, pendingFocus: {} });
	view = { mode: "live", host: { hostId: "host", generation: 1, phase: "live", transport: "tsp", tspEpoch: 1 }, guest: null, working: false, readOnly: false, displayLeaf: null } as SessionView;
	session = {
		tabId: "chat", sessionFile: "/tmp/undo.jsonl", getSnapshot: () => view,
		subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		onEvent: (listener: (event: SessionEvent) => void) => { events.add(listener); return () => events.delete(listener); },
		setDisplayLeaf: (leaf: string) => { view = { ...view, displayLeaf: leaf }; publish(); },
		command: vi.fn(async (_line: string, assertCurrent?: () => void) => { assertCurrent?.(); }),
	} as unknown as SessionController;
	invoke.mockImplementation(async () => seed.map(entry => JSON.stringify(entry)).join("\n"));
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
	vi.mocked(navigateSemantic).mockImplementation(async (controller, entry, assertCurrent, confirmLeaf) => {
		assertCurrent?.();
		const leaf = entry.userTurn ? entry.parentId : entry.id;
		confirmLeaf?.(leaf); controller.setDisplayLeaf(leaf);
		if (!entry.userTurn) return { draft: null };
		useComposerDrafts.getState().restoreEditor("chat", "rewound-prompt", "Earlier prompt");
		return { draft: "Earlier prompt" };
	});
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
	await act(async () => root.render(createElement(Reader)));
});
afterEach(async () => {
	await act(async () => { clearToasts(); root.unmount(); }); element.remove();
	expect(listeners.size).toBe(0); expect(events.size).toBe(0);
});
async function rewind() { await act(async () => { await navigateTo(session, "prompt"); }); }
async function undo() { const notice = latest.find(item => item.action?.label === "Undo")!; expect(notice).toBeDefined(); await act(async () => { notice.action!.onClick(); dismissToast(notice.id); }); }

it("returns through omp's tree to the preceding leaf and restores the displaced app draft", async () => {
	useComposerDrafts.getState().addAttachments("chat", [{ path: "/tmp/image.png", name: "image.png" }]);
	await rewind();
	expect(view.displayLeaf).toBe("first");
	expect(useComposerDrafts.getState().drafts.chat).toBe("Unfinished draft\nEarlier prompt");
	await undo();
	expect(vi.mocked(navigateSemantic).mock.calls.map(([, entry]) => entry.id)).toEqual(["prompt", "leaf"]);
	expect(view.displayLeaf).toBe("leaf");
	expect(useComposerDrafts.getState().drafts.chat).toBe("Unfinished draft");
	expect(useComposerDrafts.getState().attachments.chat).toHaveLength(1);
	expect(latest.at(-1)?.message).toBe("Rewind undone.");
});

it("removes Undo immediately after a new message and refuses a retained click", async () => {
	await rewind(); const click = latest[0]!.action!.onClick;
	await act(async () => emit({ kind: "sent" }));
	expect(latest).toHaveLength(0);
	await act(async () => click());
	expect(navigateSemantic).toHaveBeenCalledTimes(1);
});

it.each(["session", "generation", "epoch", "working", "branch", "disposed"])("retires Undo when %s changes", async change => {
	await rewind();
	await act(async () => {
		if (change === "session") Object.assign(session, { sessionFile: "/tmp/another.jsonl" });
		else if (change === "generation") view = { ...view, host: { ...view.host!, generation: 2 } };
		else if (change === "epoch") view = { ...view, host: { ...view.host!, tspEpoch: 2 } };
		else if (change === "working") view = { ...view, working: true };
		else if (change === "branch") view = { ...view, displayLeaf: "another-leaf" };
		else emit({ kind: "disposed" });
		publish();
	});
	expect(latest).toHaveLength(0);
});

it("releases the rewind checkpoint when its toast is dismissed", async () => {
	await rewind(); await act(async () => dismissToast(latest[0]!.id));
	expect(events.size).toBe(0); expect(listeners.size).toBe(0);
});

it.each(["sent", "branch"])("checks %s eligibility again after Undo waits for the editor", async change => {
	await rewind();
	const ready = Promise.withResolvers<string[]>();
	vi.mocked(readyEditor).mockReturnValueOnce(ready.promise);
	const notice = latest[0]!;
	await act(async () => {
		notice.action!.onClick(); dismissToast(notice.id);
		if (change === "sent") emit({ kind: "sent" });
		else { view = { ...view, displayLeaf: "another-leaf" }; publish(); }
		ready.resolve([]);
	});
	expect(navigateSemantic).toHaveBeenCalledTimes(1);
	expect(useComposerDrafts.getState().drafts.chat).toBe("Unfinished draft\nEarlier prompt");
});

it("leaves the draft available if omp refuses Undo", async () => {
	await rewind(); vi.mocked(navigateSemantic).mockRejectedValueOnce(new Error("Navigation refused"));
	await undo();
	expect(useComposerDrafts.getState().drafts.chat).toBe("Unfinished draft\nEarlier prompt");
	expect(latest.at(-1)?.message).toBe("Navigation refused");
});

it("keeps newer draft edits when resuming from an assistant message", async () => {
	await act(async () => { await navigateTo(session, "first"); });
	useComposerDrafts.getState().setDraft("chat", "Edited after navigation");
	await undo();
	expect(useComposerDrafts.getState().drafts.chat).toBe("Edited after navigation");
});

it("does not offer an inexact Undo for a previous user-request leaf", async () => {
	invoke.mockResolvedValue(seed.slice(0, 2).map(entry => JSON.stringify(entry)).join("\n"));
	await rewind(); expect(latest).toHaveLength(0);
});

it("uses the existing classic tree path with the drive lease on older omp", async () => {
	view = { ...view, host: { ...view.host!, transport: "classic" } };
	const scope = { hostId: "host", generation: 1, epoch: null };
	const screens = [["Session Tree"], ["│ › • user: Earlier prompt"], ["Navigated to selected point"], [" π ▶ ⬢ Sonnet 4.6 · ◒ high ▶ proj ▶─0.3%─", "╰─ "], ["Session Tree"], ["│ › • assistant: Old answer"], ["Navigated to selected point"]];
	vi.mocked(waitForScreen).mockImplementation(async (_controller, test) => {
		expect(screenActivity.has(scope, "drive")).toBe(true);
		const lines = screens.shift()!; expect(test(lines)).toBe(true); return lines;
	});
	vi.mocked(press).mockImplementation(async () => { expect(screenActivity.has(scope, "drive")).toBe(true); });
	await rewind(); await undo();
	expect(view.displayLeaf).toBe("leaf");
	expect(useComposerDrafts.getState().drafts.chat).toBe("Unfinished draft");
	expect(vi.mocked(press).mock.calls.map(([, keys]) => keys)).toEqual(["M-u", "home", "enter", "C-c", "M-a", "home down down", "enter"]);
	expect(screenActivity.has(scope, "drive")).toBe(false);
});

it.each(["opening", "row-wait", "scan", "confirmation"])("stops classic Undo after host replacement during %s", async stage => {
	view = { ...view, host: { ...view.host!, transport: "classic" } };
	const initial = [["Session Tree"], ["│ › • user: Earlier prompt"], ["Navigated to selected point"], [" π ▶ ⬢ Sonnet 4.6 · ◒ high ▶ proj ▶─0.3%─", "╰─ "]];
	vi.mocked(waitForScreen).mockImplementation(async (_controller, test) => {
		const lines = initial.shift()!; expect(test(lines)).toBe(true); return lines;
	});
	await rewind(); vi.mocked(press).mockClear();
	const replace = () => { view = { ...view, host: { ...view.host!, hostId: "replacement" } }; publish(); };
	let reads = 0;
	vi.mocked(waitForScreen).mockImplementation(async () => {
		reads++;
		if (reads === 1) { if (stage === "opening") replace(); return ["Session Tree"]; }
		if (reads === 2) {
			if (stage === "row-wait") replace();
			return stage === "scan" ? null : ["│ › • assistant: Old answer"];
		}
		replace(); return ["Navigated to selected point"];
	});
	vi.mocked(readScreen).mockImplementation(async () => { replace(); return ["Unrelated row"]; });
	await undo();
	const expected = stage === "opening" ? [] : stage === "scan" ? ["M-a", "home down down", "home"] : stage === "row-wait" ? ["M-a", "home down down"] : ["M-a", "home down down", "enter"];
	expect(vi.mocked(press).mock.calls.map(([, keys]) => keys)).toEqual(expected);
	expect(view.displayLeaf).toBe("first");
	expect(useComposerDrafts.getState().drafts.chat).toBe("Earlier prompt");
	expect(screenActivity.has({ hostId: "host", generation: 1, epoch: null }, "drive")).toBe(false);
});
