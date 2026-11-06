// @vitest-environment happy-dom
import { act, createElement, Fragment, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as MotionModule from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllChats, controllerFor, useApp } from "../state/app";
import type { SessionView } from "../state/session";
import { useComposerDrafts } from "../chat/composer/drafts";
import { setAllTabsCloseGuard } from "../registry/guards";
import { answerQuitRequest, confirmCloseAllTabs, confirmCloseTab, quitAfterConfirm, QuitDialog, useQuitRequest } from "../features/onboarding/quit";
import { PaletteHost } from "../features/palette/Palette";
import "../features/palette/commands";
import { TooltipProvider } from "../ui";
import { Sidebar } from "./Sidebar";
vi.mock("../features/session-tools/typed", () => ({ sendSlashCommand: vi.fn() }));
vi.mock("../features/session-tools/slash", () => ({ routeSlash: vi.fn() }));
import "../i18n";

vi.hoisted(() => {
	Object.assign(window, { vomp: {
		platform: "darwin", on: () => () => {},
		invoke: async (channel: string) => channel === "app:info" ? { version: "0.7.7", defaultChatFolder: "/tmp" } : channel === "app:prefs:get" ? null : [],
	} });
});
vi.mock("../state/session", () => ({ SessionController: class {
	hostId = null;
	inputSent = true;
	tabId = "";
	projectPath = "";
	sessionFile = null;
	view = { mode: "history", host: null, working: false, queue: [], guest: null };
	constructor(options: object) { Object.assign(this, options); }
	subscribe = () => () => {};
	getSnapshot = () => this.view;
	async loadHistory() {}
	async checkOwnership() {}
	async dispose() {}
	setForeground() {}
} }));
vi.mock("motion/react", async importOriginal => {
	const actual = await importOriginal<typeof MotionModule>();
	// Motion's animation clock is irrelevant to focus and ordering; preserve native refs and events.
	const React = await import("react");
	const tag = (name: string) => React.forwardRef<HTMLElement, PropsWithChildren<Record<string, unknown>>>(({ children, initial, animate, exit, transition, layout, layoutId, layoutDependency, variants, custom, onAnimationComplete, ...props }, ref) => React.createElement(name, { ...props, ref, children, "data-layout-mode": layout === false ? "off" : typeof layout === "string" ? layout : undefined, "data-layout-key": typeof layoutDependency === "string" ? layoutDependency : undefined }));
	return { ...actual, AnimatePresence: ({ children }: PropsWithChildren) => children, motion: { ...actual.motion, div: tag("div"), span: tag("span") }, useReducedMotionConfig: () => true };
});

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const tabs = ["Seen A", "Unseen A", "Seen B", "Unseen B"].map((title, index) => ({ id: `row${index}`, projectPath: "/workspace", sessionFile: `/chat${index}.jsonl`, title }));
	useApp.setState({ tabs, activeTabId: null, splitTabId: null, view: "home", prefs: null, projects: [], sessionsByProject: { "/workspace": [] }, search: "", unseenChats: { row1: "finished", row3: "finished" } });
	for (const tab of tabs) useApp.getState().activateTab(tab.id);
	for (const tab of tabs) {
		// Reset the reusable mock controllers' reported state between interactions.
		const controller = controllerFor(tab.id) as unknown as { view: SessionView };
		controller.view = { mode: "history", host: null, working: false, queue: [], guest: null } as unknown as SessionView;
	}
	useApp.setState({ view: "home", paletteOpen: false });
	container = document.createElement("div"); document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Sidebar, { width: 200 }))));
});
afterEach(async () => { await act(async () => { answerQuitRequest(false); root.unmount(); }); container.remove(); });

const section = () => container.querySelector('section[aria-label="Current chats"]')!;
const rows = () => [...section().querySelectorAll<HTMLButtonElement>("button[data-row-title]")];
const titles = () => rows().map(row => row.textContent);
const title = (text: string) => rows().find(row => row.textContent === text)!;
async function frame() { const { promise, resolve } = Promise.withResolvers<void>(); requestAnimationFrame(() => resolve()); await promise; }
async function key(row: HTMLElement, key: string) {
	await act(async () => { row.focus(); row.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true })); await frame(); });
}
function dragEvent(type: string, y = 0) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, { clientY: { value: y }, dataTransfer: { value: { effectAllowed: "", dropEffect: "", setData() {} } } });
	return event;
}

describe("Current chats reordering", () => {
	it("keys row measurement to order changes and disables projection for reduced motion", async () => {
		const row = title("Seen B").closest("[data-layout-key]")!;
		const before = row.getAttribute("data-layout-key");
		expect(row.getAttribute("data-layout-mode")).toBe("off");
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(Sidebar, { width: 201 }))));
		expect(row.getAttribute("data-layout-key")).toBe(before);
		await key(title("Seen B"), "ArrowUp");
		expect(row.getAttribute("data-layout-key")).not.toBe(before);
		expect(row.isConnected).toBe(true);
	});
	it("moves a focused title by keyboard, announces the displayed position and updates shortcut numbers", async () => {
		expect(titles()).toEqual(["Unseen A", "Unseen B", "Seen A", "Seen B"]);
		await key(title("Seen B"), "ArrowUp");
		expect(titles()).toEqual(["Unseen A", "Unseen B", "Seen B", "Seen A"]);
		expect(document.activeElement).toBe(title("Seen B"));
		expect(section().querySelector('[role="status"]')?.textContent).toBe("Seen B moved to position 3 of 4.");
		expect(title("Seen B").getAttribute("aria-keyshortcuts")).toContain("Meta+1");
		expect(title("Seen A").getAttribute("aria-keyshortcuts")).toContain("Meta+2");
		await key(title("Seen B"), "ArrowUp");
		expect(titles()).toEqual(["Unseen A", "Unseen B", "Seen B", "Seen A"]);
		expect(section().querySelector('[role="status"]')?.textContent).toContain("Unopened results stay above viewed chats");
		expect(document.activeElement).toBe(title("Seen B"));
	});

	it("maps a drag across the divider to the nearest end of its original group", async () => {
		const dragged = title("Seen B").closest('[draggable="true"]')!;
		await act(async () => { dragged.dispatchEvent(dragEvent("dragstart")); });
		const target = title("Unseen A").closest('[draggable="true"]')!;
		await act(async () => { target.dispatchEvent(dragEvent("dragover", -1)); });
		await act(async () => { target.dispatchEvent(dragEvent("drop")); });
		expect(titles()).toEqual(["Unseen A", "Unseen B", "Seen B", "Seen A"]);
		expect(useApp.getState().tabs.map(tab => tab.title)).toEqual(["Seen B", "Seen A", "Unseen A", "Unseen B"]);
		const numbers = rows().map(row => row.getAttribute("aria-keyshortcuts"));
		await act(async () => { useApp.setState({ unseenChats: {} }); });
		expect(titles()).toEqual(["Seen B", "Seen A", "Unseen A", "Unseen B"]);
		expect(title("Unseen A").getAttribute("aria-keyshortcuts")).toBe(numbers[0]);
	});

	it("offers moves in both row menus and returns focus to the moved title", async () => {
		const row = title("Seen B").parentElement!;
		const menu = row.querySelector<HTMLButtonElement>('button[aria-label="Chat options"]')!;
		await act(async () => { menu.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })); });
		let up = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes("Move up"));
		expect(up).toBeDefined();
		await act(async () => { up!.click(); });
		await act(async () => { await frame(); });
		expect(titles()).toEqual(["Unseen A", "Unseen B", "Seen B", "Seen A"]);
		await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(title("Seen B"))); });
		await act(async () => { title("Seen A").parentElement!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 })); });
		up = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes("Move up"));
		expect(up).toBeDefined();
		await act(async () => { up!.click(); });
		await act(async () => { await frame(); });
		expect(titles()).toEqual(["Unseen A", "Unseen B", "Seen A", "Seen B"]);
		await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(title("Seen A"))); });
	});
});

it("lists bulk-close work and lost drafts, focuses Cancel and preserves chats until confirmation", async () => {
	await act(async () => { await useApp.getState().init(); });
	const live = (working: boolean, helpers = 0, phase = "live") => ({
		mode: "live", host: { phase: "running" }, working, queue: [],
		guest: { phase, agents: Array.from({ length: helpers }, (_, index) => ({ id: `helper${index}`, status: "running", kind: "sub" })), progress: new Map(), lifecycle: new Map() },
	}) as unknown as SessionView;
	for (const [id, view] of [["row0", live(true)], ["row1", live(false, 1)], ["row2", live(false, 0, "connecting")]] as const) {
		// The mock controller exposes its view so the test can change omp's reported state.
		const controller = controllerFor(id) as unknown as { view: SessionView };
		controller.view = view;
	}
	useComposerDrafts.getState().setDraft("row3", "Unsent note");
	useComposerDrafts.getState().addAttachments("row0", [{ path: "/image.png", name: "image.png" }]);
	useApp.setState(state => ({ tabs: state.tabs.map(tab => tab.id === "row3" ? { ...tab, sessionFile: null } : tab) }));
	setAllTabsCloseGuard(confirmCloseAllTabs);
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Fragment, null, createElement(Sidebar, { width: 200 }), createElement("main", { id: "vo-main", tabIndex: -1 }), createElement(QuitDialog)))));
	const before = useApp.getState().tabs;
	const trigger = section().querySelector<HTMLButtonElement>('button[aria-label="Current chats options"]')!;
	await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })); });
	await act(async () => { await frame(); });
	const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element => element.textContent === "Close all chats")!;
	await act(async () => { item.click(); });
	let closing = closeAllChats();
	// A running host whose room is still connecting stays unknown after quit's bounded wait.
	const { promise, resolve } = Promise.withResolvers<void>();
	const stop = useQuitRequest.subscribe(state => { if (state.request) { stop(); resolve(); } });
	await act(async () => { await promise; await frame(); });
	const dialog = document.querySelector('[role="dialog"]')!;
	expect(dialog.textContent).toContain("omp was replying in 1 chat");
	expect(dialog.textContent).toContain("1 helper was working");
	expect(dialog.textContent).toContain("could not check whether omp is working in 1 chat");
	for (const label of ["Seen A", "Unseen A", "Seen B", "Not checked", "Drafts that will be discarded", "Unseen B", "Text", "1 attachment"]) expect(dialog.textContent).toContain(label);
	const cancel = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Cancel")!;
	expect(document.activeElement).toBe(cancel);
	expect(useQuitRequest.getState().request?.opener).toBe(trigger);
	await act(async () => { cancel.click(); await closing; });
	await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(trigger)); });
	expect(useApp.getState().tabs).toEqual(before);
	expect(useComposerDrafts.getState().drafts.row3).toBe("Unsent note");
	expect(useComposerDrafts.getState().attachments.row0).toHaveLength(1);
	// The next answer uses a known room, so the same guard can ask immediately.
	const controller = controllerFor("row2") as unknown as { view: SessionView };
	controller.view = live(false);
	await act(async () => { closing = closeAllChats(); await frame(); });
	const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === "Close all chats")!;
	await act(async () => { confirm.click(); await closing; });
	await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(document.getElementById("vo-main"))); });
	expect(useApp.getState().tabs).toEqual([]);
	expect(useComposerDrafts.getState().attachments.row0).toBeUndefined();
	await act(async () => { expect(await useApp.getState().reopenClosedChat()).toBe(true); });
	expect(useApp.getState().tabs.at(-1)?.sessionFile).toBe("/chat2.jsonl");
}, 15_000);

it("returns focus to the header menu after Escape", async () => {
	await act(async () => { await useApp.getState().init(); });
	setAllTabsCloseGuard(confirmCloseAllTabs);
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Fragment, null, createElement(Sidebar, { width: 200 }), createElement(QuitDialog)))));
	const trigger = section().querySelector<HTMLButtonElement>('button[aria-label="Current chats options"]')!;
	await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })); });
	await act(async () => { await frame(); });
	const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element => element.textContent === "Close all chats")!;
	await act(async () => { item.click(); await frame(); });
	await act(async () => { await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull()); });
	await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
	await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(trigger)); });
	expect(useApp.getState().tabs).toHaveLength(4);
});

it.each(["tab", "quit"] as const)("restores the invoking control when cancelling a shared %s warning", async kind => {
	await act(async () => { await useApp.getState().init(); });
	const controller = controllerFor("row0") as unknown as { view: SessionView };
	controller.view = { ...controller.view, working: true };
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Fragment, null, createElement(Sidebar, { width: 200 }), createElement(QuitDialog)))));
	const opener = container.querySelector<HTMLButtonElement>("[data-new-chat]")!;
	const quit = vi.fn(async () => {});
	let answer: Promise<unknown>;
	await act(async () => { opener.focus(); answer = kind === "tab" ? confirmCloseTab("row0") : quitAfterConfirm(quit); await frame(); });
	await act(async () => { await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull()); });
	await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await answer; });
	await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(opener)); });
	expect(quit).not.toHaveBeenCalled();
	expect(useApp.getState().tabs).toHaveLength(4);
});

it("returns palette-invoked cancellation to the surviving main area", async () => {
	await act(async () => { await useApp.getState().init(); });
	setAllTabsCloseGuard(confirmCloseAllTabs);
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Fragment, null,
		createElement(Sidebar, { width: 200 }), createElement("main", { id: "vo-main", tabIndex: -1 }), createElement(PaletteHost), createElement(QuitDialog)))));
	await act(async () => { useApp.getState().setPaletteOpen(true); await frame(); });
	await act(async () => { await vi.waitFor(() => expect(document.querySelector("[cmdk-input]")).not.toBeNull()); });
	const input = document.querySelector<HTMLInputElement>('[cmdk-input]')!;
	await act(async () => {
		input.focus();
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Close all chats");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const command = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find(item => item.textContent?.includes("Close all chats"))!;
	expect(command).toBeDefined();
	await act(async () => { command.click(); await frame(); });
	await act(async () => { await vi.waitFor(() => expect(useQuitRequest.getState().request).not.toBeNull()); });
	expect(useApp.getState().paletteOpen).toBe(false);
	const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === "Cancel")!;
	await act(async () => { cancel.click(); });
	await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(document.getElementById("vo-main"))); });
	expect(useApp.getState().tabs).toHaveLength(4);
});
