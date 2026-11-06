// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../../i18n";
import { i18n } from "../../i18n";
import type { SessionController, SessionEvent, SessionView } from "../../state/session";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { TooltipProvider } from "../../ui";
import type { Helper } from "./derive";
import { closeHelper, openHelper, useHelperFocus } from "./helperFocus";
import { HelperFocusView } from "./HelperFocusView";
import { helperConversation } from "./helperConversation";

const render = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../chat/transcript/Transcript", () => ({ TranscriptBody: ({ entries, renderUser }: { entries: SessionEntry[]; renderUser(entry: SessionEntry): ReactNode }) => {
	render.count++;
	return createElement("div", { "data-test-transcript": true }, entries.map(entry => createElement("div", { key: entry.id }, entry.type === "message" && entry.message.role === "user" ? renderUser(entry) : JSON.stringify(entry))));
} }));
vi.mock("../../ui/TargetContextMenu", () => ({ TargetContextMenu: ({ children }: { children: ReactNode }) => children }));

let container: HTMLDivElement;
let root: Root;
let session: SessionController;
let events: Set<(event: SessionEvent) => void>;
let fileListeners: Set<(event: { file: string; text: string; reset: boolean }) => void>;
const helper = { id: "Atlas", name: "Atlas", status: "running", messageable: true, hasTranscript: true } as Helper;

function FocusHost(): ReactNode {
	const focus = useHelperFocus(session.tabId);
	return createElement("section", null,
		createElement("div", { "data-main-chat": true, inert: !!focus, hidden: !!focus }, createElement("button", { onClick: () => openHelper(session, helper) }, "Open helper")),
		focus && createElement(HelperFocusView, { session, helper: focus }),
	);
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	Object.defineProperty(document, "hidden", { configurable: true, value: false });
	events = new Set(); fileListeners = new Set(); render.count = 0;
	const view = { mode: "live", readOnly: false, host: { hostId: "host", generation: 1, phase: "live" }, guest: { phase: "live", readOnly: false, header: { id: "parent" }, agents: [{ id: "Atlas", kind: "sub", status: "running", hasSessionFile: true }], progress: new Map(), lifecycle: new Map(), notices: [] } } as unknown as SessionView;
	session = { tabId: `tab-${Math.random()}`, projectPath: "/project", sessionFile: "/parent.jsonl", getSnapshot: () => view, subscribe: () => () => {}, guestClient: () => null,
		onEvent: (listener: (event: SessionEvent) => void) => { events.add(listener); return () => events.delete(listener); },
	} as unknown as SessionController;
	window.vomp = { platform: "darwin", invoke: vi.fn(async (channel: string) => channel === "sessions:helperFile" ? "/parent/Atlas.jsonl" : undefined), on: (channel: string, listener: (event: { file: string; text: string; reset: boolean }) => void) => {
		if (channel === "sessions:tail") fileListeners.add(listener);
		return () => { if (channel === "sessions:tail") fileListeners.delete(listener); };
	} } as unknown as typeof window.vomp;
	await i18n.loadNamespaces(["panes", "chat", "helperFocus"]);
	container = document.createElement("div"); document.body.append(container); root = createRoot(container);
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(FocusHost))));
});
afterEach(async () => {
	await act(async () => { for (const event of [...events]) event({ kind: "disposed" }); root.unmount(); });
	container.remove();
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
async function open() {
	const opener = container.querySelector<HTMLButtonElement>("[data-main-chat] button")!; opener.focus();
	await act(async () => opener.click()); return opener;
}
function tail(text: string, reset: boolean) { for (const listener of fileListeners) listener({ file: "/parent/Atlas.jsonl", text, reset }); }
const first = `${JSON.stringify({ type: "session", id: "helper", cwd: "/helper/project" })}\n${JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-11-05T12:00:00Z", message: { role: "user", content: "Complete assignment thoroughly:\n\nRead the files.", timestamp: 1 } })}\n`;

it("focuses the helper inside its chat, keeps the main chat mounted, and Back restores the opener", async () => {
	const opener = await open();
	expect(container.querySelector("[data-main-chat]")?.hasAttribute("inert")).toBe(true);
	expect(container.querySelector("[data-helper-focus]")?.textContent).toContain("Atlas's conversation");
	expect(document.querySelector("[role=dialog]")).toBeNull();
	const back = [...container.querySelectorAll("button")].find(button => button.textContent === "Back to chat")!;
	expect(document.activeElement).toBe(back);
	await act(async () => back.click());
	const frame = Promise.withResolvers<number>(); requestAnimationFrame(frame.resolve); await frame.promise;
	expect(container.querySelector("[data-helper-focus]")).toBeNull();
	expect(document.activeElement).toBe(opener);
});
it("Escape returns to the main chat without sending or aborting, and restores keyboard focus", async () => {
	const opener = await open();
	await act(async () => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	const frame = Promise.withResolvers<number>(); requestAnimationFrame(frame.resolve); await frame.promise;
	expect(container.querySelector("[data-helper-focus]")).toBeNull(); expect(document.activeElement).toBe(opener);
});
it("appends entries live and catches up once when the hidden window becomes visible", async () => {
	await open();
	await act(async () => tail(first, true));
	expect(container.textContent).toContain("Assignment"); expect(container.textContent).toContain("Read the files.");
	const before = render.count;
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
	Object.defineProperty(document, "hidden", { configurable: true, value: true });
	await act(async () => document.dispatchEvent(new Event("visibilitychange")));
	for (let index = 0; index < 5; index++) await act(async () => tail(`${JSON.stringify({ type: "message", id: `a${index}`, parentId: index ? `a${index - 1}` : "u1", timestamp: "2026-11-05T12:00:01Z", message: { role: "assistant", content: [{ type: "text", text: `Live entry ${index}` }], timestamp: index + 2 } })}\n`, false));
	expect(render.count).toBe(before); expect(container.textContent).not.toContain("Live entry 4");
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	Object.defineProperty(document, "hidden", { configurable: true, value: false });
	await act(async () => document.dispatchEvent(new Event("visibilitychange")));
	expect(container.textContent).toContain("Live entry 4"); expect(render.count).toBe(before + 1);
	await act(async () => closeHelper(session));
});
it("shows the waiting state with an enabled composer before the helper transcript exists", async () => {
	vi.mocked(window.vomp.invoke).mockResolvedValueOnce(null);
	await open();
	expect(container.textContent).toContain("No conversation yet. You can still send a message.");
	expect(container.querySelector("[role=alert]")).toBeNull();
	expect(container.querySelector("textarea")!.disabled).toBe(false);
});
it("queues a working helper's composer input and permits cancelling it", async () => {
	await open();
	const textarea = container.querySelector("textarea")!;
	await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!; setter.call(textarea, "Keep this until idle"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
	await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
	expect(container.textContent).toContain("Queued until the helper is idle.");
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Cancel queued message"]')!.click());
	expect(container.textContent).not.toContain("Keep this until idle");
});

it("retains ended-guest messages with copy guidance and disables an unavailable retry", async () => {
	await open();
	const conversation = helperConversation(session, helper);
	await act(async () => { conversation.setDraft("Copy this exact text"); conversation.enqueue(); });
	const view = session.getSnapshot();
	view.guest = { ...view.guest!, phase: "ended" };
	let off: (() => void) | undefined;
	await act(async () => { off = conversation.subscribe(() => {}); });
	expect(container.textContent).toContain("Copy this exact text");
	expect([...container.querySelectorAll(".selectable")].some(element => element.textContent === "Copy this exact text")).toBe(true);
	expect(container.textContent).toContain("Copy this message before restarting omp");
	const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Try sending again")!;
	expect(retry.disabled).toBe(true);
	await act(async () => retry.click());
	expect(conversation.getSnapshot().queue[0]?.state).toBe("error");
	off?.();
});
