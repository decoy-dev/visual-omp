// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { SessionController, SessionView } from "../state/session";
import type { TranscriptProps } from "./transcript/Transcript";
import type * as TranscriptModule from "./transcript/Transcript";
import type * as MotionReact from "motion/react";
import { PresentationVisibility } from "../state/tsp/presentation-claims";
import { TooltipProvider } from "../ui";
import "../i18n";


const cold = vi.hoisted(() => ({
	load: null as Promise<void> | null,
	ready: Promise.withResolvers<void>(),
	attempts: 0,
	mounts: new Map<string, number>(),
	unmounts: new Map<string, number>(),
	state: { activeTabId: "restored", splitTabId: null, prefs: { transcriptMode: "normal", liveThinking: true }, btwDrawers: {}, projects: [], focusSplit: vi.fn() },
}));

// Only the chunk export is deferred. Once resolved, the actual Transcript and its rendering,
// subscriptions, Markdown, pacing and scroll-follow hooks run beneath the actual lazyView boundary.
vi.mock("./transcript/Transcript", async importOriginal => {
	const actual = await importOriginal<typeof TranscriptModule>();
	function TrackedTranscript(props: TranscriptProps) {
		useEffect(() => {
			const id = props.session.tabId;
			cold.mounts.set(id, (cold.mounts.get(id) ?? 0) + 1);
			return () => { cold.unmounts.set(id, (cold.unmounts.get(id) ?? 0) + 1); };
		}, [props.session]);
		return createElement(actual.Transcript, props);
	}
	cold.ready.resolve();
	return {
		get Transcript() {
			cold.attempts++;
			// import(...).then(module => module.Transcript) adopts this promise, including rejection.
			return cold.load!.then(() => TrackedTranscript);
		},
	};
});
// Motion's native cancellation rejects happy-dom's animation promise during teardown.
// DOM-only motion wrappers keep this test about the cold boundary; Chromium checks use actual motion.
vi.mock("motion/react", async importOriginal => {
	const actual = await importOriginal<typeof MotionReact>();
	// This factory is hoisted, before this module's React imports are initialized.
	const { createElement, forwardRef } = await import("react");
	const wrappers = new Map<string, object>();
	for (const tag of ["div", "span", "button", "li", "ul", "section"]) {
		wrappers.set(tag, forwardRef<HTMLElement, Record<string, unknown>>((props, ref) =>
			createElement(tag, { ...Object.fromEntries(Object.entries(props).filter(([key]) => !actual.isValidMotionProp(key))), ref })));
	}
	return { ...actual, motion: new Proxy(actual.motion, { get: (target, key) => typeof key === "string" && wrappers.has(key) ? wrappers.get(key) : Reflect.get(target, key) }) };
});
vi.mock("../registry/idle", () => ({ preloadWhenIdle: () => {} }));
vi.mock("../registry/slots", () => ({ chatSlots: { use: () => [] } }));
vi.mock("../state/app", () => ({
	useApp: Object.assign((select: (state: typeof cold.state) => unknown) => select(cold.state), { getState: () => cold.state, subscribe: () => () => {} }),
	dockKey: (state: typeof cold.state) => state.activeTabId,
	currentDock: () => null,
	useDockVisible: () => false,
	controllerFor: () => null,
}));
// Keep a focusable, retained composer without unrelated send, account and prediction IPC.
vi.mock("./composer/Composer", () => ({ Composer: ({ session }: { session: SessionController }) => createElement("textarea", { "aria-label": `Message ${session.tabId}`, defaultValue: `Draft ${session.tabId}` }) }));
vi.mock("./SessionHeader", () => ({ SessionHeader: ({ fallbackTitle }: { fallbackTitle: string }) => createElement("header", null, fallbackTitle) }));

import { ChatView } from "./ChatView";

interface Fixture {
	session: SessionController;
	stream(text: string, entries?: readonly SessionEntry[]): void;
}

const timestamp = "2026-11-05T12:00:00.000Z";
function user(id: string, text: string, parentId: string | null = null): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content: text, timestamp: Date.parse(timestamp) } };
}
function reply(text: string): AssistantMessage {
	return {
		role: "assistant", model: "cold-fixture", timestamp: Date.parse(timestamp), stopReason: "stop",
		content: [{ type: "text", text }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	};
}
function restored(tabId: string, text: string): Fixture {
	const entries = [user(`${tabId}-saved`, text)];
	let view = {
		mode: "history", host: null, guest: null,
		history: { header: { id: tabId }, entries, all: entries, title: null },
		queue: [], inputHistory: [], working: false, workingSince: null, readOnly: false, follow: null,
		ownerUnverified: false, displayLeaf: null, carryover: null, strandedImages: false, error: null,
	} as unknown as SessionView;
	const listeners = new Set<() => void>();
	const notices: readonly never[] = [];
	const session = {
		tabId, projectPath: "/cold-transcript-fixture",
		subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		getSnapshot: () => view,
		onEvent: () => () => {}, guestClient: () => null,
		tspNotices: { subscribe: () => () => {}, getSnapshot: () => notices },
	} as unknown as SessionController;
	return {
		session,
		stream(text: string, entries = view.history!.entries) {
			view = {
				...view, mode: "live", working: true,
				guest: { phase: "live", header: { id: tabId }, entries, stream: reply(text), streamDone: false, activeTools: new Map(), agents: [], progress: new Map(), lifecycle: new Map(), uiRequest: null, loading: null } as unknown as NonNullable<SessionView["guest"]>,
			};
			for (const listener of listeners) listener();
		},
	};
}

function RetainedChats({ chats, active }: { chats: Fixture[]; active: string }) {
	return createElement(TooltipProvider, null,
		createElement("div", { className: "relative flex min-h-0 flex-1" }, chats.map(({ session }) => {
			const visible = session.tabId === active;
			// ChatArea's narrow split convention: retain the pane, hide it out of flow and make it inert.
			return createElement("div", {
				key: session.tabId, "data-retained-chat": session.tabId, inert: !visible,
				className: `flex min-w-0 flex-1 flex-col${visible ? "" : " invisible absolute inset-0"}`,
			}, createElement(PresentationVisibility, { visible }, createElement(ChatView, { session, title: session.tabId, focused: visible })));
		})),
	);
}

let element: HTMLDivElement;
let root: Root;
let caught: unknown[];
let uncaught: unknown[];
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: vi.fn(async (channel: string) => channel === "app:info" ? { homeDir: "/cold-transcript-fixture" } : []) } });
	vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
	cold.attempts = 0;
	cold.mounts.clear();
	cold.unmounts.clear();
	element = document.createElement("div");
	document.body.append(element);
	caught = [];
	uncaught = [];
	root = createRoot(element, { onCaughtError: error => caught.push(error), onUncaughtError: error => uncaught.push(error) });
});
afterEach(async () => {
	await act(async () => root.unmount());
	element.remove();
	vi.unstubAllGlobals();
});

function column(id: string): HTMLElement {
	return element.querySelector(`[data-retained-chat="${id}"]`)!;
}
function composer(id: string): HTMLTextAreaElement {
	return column(id).querySelector("textarea")!;
}

// A single cold lifecycle keeps lazyView's module-scope cache intact through failure, retry and
// subsequent switches, as it is in the application. No resetModules creates a second React runtime.
describe("cold retained chat transcript", () => {
	it("keeps restored and streaming data, composer focus and transcript identity through loading, failure, retry and chat switches", async () => {
		const firstLoad = Promise.withResolvers<void>();
		cold.load = firstLoad.promise;
		const chats = [restored("restored", "Initially restored question."), restored("other", "Other retained question.")];
		const show = async (active: string) => {
			cold.state.activeTabId = active;
			await act(async () => root.render(createElement(RetainedChats, { chats, active })));
		};
		await show("restored");
		await act(async () => { await cold.ready.promise; });
		const firstComposer = composer("restored");
		firstComposer.focus();
		expect(document.activeElement).toBe(firstComposer);
		expect(column("restored").querySelector('[data-transcript-frame="loading"]')?.getAttribute("aria-busy")).toBe("true");
		expect(element.querySelector('[role="log"]')).toBeNull();
		expect(cold.mounts.size).toBe(0);
		expect(cold.attempts).toBe(1);

		await act(async () => chats[0]!.stream("An obsolete partial reply."));
		await act(async () => chats[0]!.stream("Latest **restored reply** before resolution."));
		expect(document.activeElement).toBe(firstComposer);
		await show("other");
		const otherComposer = composer("other");
		otherComposer.focus();
		await act(async () => chats[1]!.stream("Latest **other reply** before resolution."));
		expect(column("restored").hasAttribute("inert")).toBe(true);
		expect(column("restored").className).toContain("invisible absolute inset-0");
		expect(column("other").hasAttribute("inert")).toBe(false);
		expect(document.activeElement).toBe(otherComposer);
		expect(composer("restored")).toBe(firstComposer);

		// React may retry a rejected render before committing each pane's load boundary.
		await act(async () => { firstLoad.reject(new Error("Fixture chunk unavailable")); });
		expect(column("other").querySelector('[data-transcript-frame="error"]')).not.toBeNull();
		expect(column("other").textContent).toContain("Try again");
		expect(column("restored").querySelector('[data-transcript-frame="error"]')).not.toBeNull();
		expect(document.activeElement).toBe(otherComposer);
		expect(caught.length).toBeGreaterThan(0);
		expect(caught.every(error => error instanceof Error && error.message === "A part of the window did not load.")).toBe(true);
		const failedAttempts = cold.attempts;

		const retryLoad = Promise.withResolvers<void>();
		cold.load = retryLoad.promise;
		await act(async () => chats[1]!.stream("Newest **other reply** during retry."));
		const retry = [...column("other").querySelectorAll("button")].find(button => button.textContent === "Try again")!;
		await act(async () => retry.click());
		expect(column("other").querySelector('[data-transcript-frame="loading"]')).not.toBeNull();
		expect(document.activeElement).toBe(otherComposer);
		expect(cold.attempts).toBeGreaterThan(failedAttempts);
		await act(async () => { retryLoad.resolve(); });
		const otherLog = column("other").querySelector('[role="log"]')!;
		expect(otherLog.textContent).toContain("Other retained question.");
		expect(otherLog.querySelector("strong")?.textContent).toBe("other reply");
		expect(otherLog.textContent).toContain("Newest other reply during retry.");
		expect(otherLog.textContent).not.toContain("Latest other reply before resolution.");
		expect(document.activeElement).toBe(otherComposer);
		expect(cold.mounts.get("other")).toBe(1);
		const loadedAttempts = cold.attempts;

		// The hidden pane owns a separate failure boundary. Its retry reuses the successful chunk.
		await show("restored");
		firstComposer.focus();
		const retryRestored = [...column("restored").querySelectorAll("button")].find(button => button.textContent === "Try again")!;
		await act(async () => retryRestored.click());
		const restoredLog = column("restored").querySelector('[role="log"]')!;
		expect(restoredLog.textContent).toContain("Initially restored question.");
		expect(restoredLog.textContent).toContain("Latest restored reply before resolution.");
		expect(restoredLog.textContent).not.toContain("An obsolete partial reply.");
		expect(restoredLog.querySelector("strong")?.textContent).toBe("restored reply");
		expect(document.activeElement).toBe(firstComposer);
		expect(cold.mounts.get("restored")).toBe(1);

		await show("other");
		otherComposer.focus();
		expect(column("other").querySelector('[role="log"]')).toBe(otherLog);
		await show("restored");
		firstComposer.focus();
		expect(column("restored").querySelector('[role="log"]')).toBe(restoredLog);
		expect(composer("restored")).toBe(firstComposer);
		expect(firstComposer.value).toBe("Draft restored");
		expect(document.activeElement).toBe(firstComposer);
		expect([...cold.mounts]).toEqual([["other", 1], ["restored", 1]]);
		expect(cold.unmounts.size).toBe(0);
		expect(cold.attempts).toBe(loadedAttempts);
		expect(uncaught).toEqual([]);
	});
});
