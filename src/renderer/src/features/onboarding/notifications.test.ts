// @vitest-environment happy-dom
import type { CollabUiRequest, SessionEntry } from "@oh-my-pi/pi-wire";
import type { AppPreferences, HostState, IpcEventMap } from "@shared/ipc";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestSnapshot } from "../../collab/lib/client";
import { i18n } from "../../i18n";
import { chatStatus, useSessionView } from "../../shell/hooks";
import { allControllers, controllerFor, useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { installNotifications } from "./notifications";

// Only the collab transport is replaced. SessionController owns the snapshot and event subscriptions.
const transport = vi.hoisted(() => {
	const guests = new Map<string, FakeGuest>();
	class FakeGuest {
		readonly listeners = new Set<() => void>();
		snapshot: GuestSnapshot = {
			phase: "connecting", endedReason: null, header: null, entries: [], state: null,
			agents: [], progress: new Map(), lifecycle: new Map(), stream: null, streamDone: false,
			activeTools: new Map(), backgroundTools: new Map(), working: false, readOnly: false,
			uiRequest: null, notices: [], thinkingSelector: null, loading: null,
		};
		constructor(readonly link: string) { guests.set(link, this); }
		subscribe(listener: () => void): () => void {
			this.listeners.add(listener);
			return () => { this.listeners.delete(listener); };
		}
		getSnapshot(): GuestSnapshot { return this.snapshot; }
		connect(): void {}
		close(): void {}
		emit(patch: Partial<GuestSnapshot>): void {
			this.snapshot = { ...this.snapshot, phase: "live", ...patch };
			for (const listener of this.listeners) listener();
		}
	}
	return { guests, FakeGuest };
});
vi.mock("../../collab/lib/client", () => ({ APP_GUEST_NAME: "visual-omp", GuestClient: transport.FakeGuest }));

let root: Root;
let container: HTMLDivElement;
let visibility: DocumentVisibilityState;
let focused: boolean;
let removeNotificationListeners: () => void;
const listeners = new Map<string, Set<(payload: never) => void>>();
const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => null);

function sendMain<K extends keyof IpcEventMap>(channel: K, payload: IpcEventMap[K]): void {
	for (const listener of listeners.get(channel) ?? []) listener(payload as never);
}

function host(id: string): HostState {
	return {
		hostId: `host-${id}`, cwd: "/project", phase: "live", link: `room-${id}`,
		generation: 1, sessionId: `session-${id}`, sessionFile: null, pid: 1,
		exitCode: null, error: null, tui: null, cols: 80, rows: 24, transport: "tsp",
	};
}

async function setVisibility(next: DocumentVisibilityState): Promise<void> {
	await act(async () => {
		visibility = next;
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	visibility = "visible";
	focused = true;
	vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
	vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
	Object.defineProperty(window, "vomp", {
		configurable: true,
		value: {
			platform: "darwin", invoke,
			on(channel: string, listener: (payload: never) => void) {
				const channelListeners = listeners.get(channel) ?? new Set();
				listeners.set(channel, channelListeners);
				channelListeners.add(listener);
				return () => { channelListeners.delete(listener); };
			},
		},
	});
	invoke.mockClear();
	listeners.clear();
	transport.guests.clear();
	localStorage.clear();
	removeNotificationListeners = () => undefined;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	removeNotificationListeners();
	await Promise.all(allControllers().map(controller => controller.dispose()));
	container.remove();
	listeners.clear();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("hidden chat notifications", () => {
	it("records questions, approvals and completion before visual subscriptions resume, then acknowledges only shown chats with focus", async () => {
		useApp.setState({
			prefs: { notifications: true } as AppPreferences,
			tabs: [
				{ id: "question", projectPath: "/project", sessionFile: null, title: "Question chat" },
				{ id: "approval", projectPath: "/project", sessionFile: null, title: "Approval chat" },
			],
			unseenChats: {}, activeTabId: null, splitTabId: null, docks: {}, view: "home",
		});
		// Navigation creates the production controllers, including the secondary split chat.
		useApp.getState().activateTab("approval");
		useApp.getState().activateTab("question");
		useApp.getState().activateTab("approval", { split: true });
		const question = controllerFor("question")!;
		const approval = controllerFor("approval")!;
		question.attach(host("question"));
		approval.attach(host("approval"));
		const questionGuest = transport.guests.get("room-question")!;
		const approvalGuest = transport.guests.get("room-approval")!;
		questionGuest.emit({ working: true });
		approvalGuest.emit({ working: true });

		// Capture the installer's browser listeners because its app-lifetime API has no disposer.
		const windowEvents = vi.spyOn(window, "addEventListener");
		const documentEvents = vi.spyOn(document, "addEventListener");
		installNotifications();
		const installedWindowEvents = [...windowEvents.mock.calls];
		const installedDocumentEvents = [...documentEvents.mock.calls];
		removeNotificationListeners = () => {
			for (const [name, listener, options] of installedWindowEvents) window.removeEventListener(name, listener, options);
			for (const [name, listener, options] of installedDocumentEvents) document.removeEventListener(name, listener, options);
		};
		expect(invoke).toHaveBeenCalledWith("app:attention", { count: 0, alert: false, overlay: null });

		const rendered = vi.fn();
		function Chat({ controller }: { controller: SessionController }) {
			const status = chatStatus(useSessionView(controller));
			rendered(controller.tabId, status);
			return createElement("p", null, `${controller.tabId}:${status}`);
		}
		await act(async () => root.render(createElement("div", null,
			createElement(Chat, { controller: question }), createElement(Chat, { controller: approval }),
		)));
		expect(container.textContent).toBe("question:workingapproval:working");
		await setVisibility("hidden");
		const rendersBeforeHiddenEvents = rendered.mock.calls.length;
		invoke.mockClear();

		const questionRequest: CollabUiRequest = { reqId: 1, kind: "select", title: "Which database?", options: ["SQLite", "PostgreSQL"] };
		const approvalRequest: CollabUiRequest = { reqId: 2, kind: "select", title: "Run command?", options: ["Approve Once", "Deny"] };
		await act(async () => questionGuest.emit({ uiRequest: questionRequest }));
		expect(document.visibilityState).toBe("hidden");
		expect(document.hasFocus()).toBe(true);
		expect(useApp.getState().unseenChats).toEqual({ question: "needsInput" });
		expect(invoke).toHaveBeenCalledWith("app:attention", { count: 1, alert: true, overlay: null });
		expect(invoke).toHaveBeenCalledWith("app:notify", "Question chat", i18n.t("onboarding:notify.needsInput"), "question");

		await act(async () => approvalGuest.emit({ uiRequest: approvalRequest }));
		expect(useApp.getState().unseenChats).toEqual({ question: "needsInput", approval: "needsInput" });
		expect(invoke).toHaveBeenCalledWith("app:attention", { count: 2, alert: true, overlay: null });
		expect(invoke).toHaveBeenCalledWith("app:notify", "Approval chat", i18n.t("onboarding:notify.needsInput"), "approval");

		const reply = {
			type: "message", id: "answer", parentId: null, timestamp: "2026-11-05T00:00:00Z",
			message: { role: "assistant", content: [{ type: "text", text: "## **Updated** the database configuration" }] },
		} as SessionEntry;
		await act(async () => questionGuest.emit({
			uiRequest: null, working: false, entries: [reply],
			completion: [1, 176, 0],
		}));
		await vi.dynamicImportSettled();
		expect(document.visibilityState).toBe("hidden");
		expect(useApp.getState().unseenChats).toEqual({ question: "finished", approval: "needsInput" });
		expect(invoke).toHaveBeenCalledWith("app:notify", "Question chat", i18n.t("onboarding:notify.finishedWith", { summary: "Updated the database configuration" }), "question");
		expect(invoke).toHaveBeenCalledWith("app:completionDiagnostic", ["question", expect.any(Number), expect.any(Number), 0, 2, 22, null, 0, 3]);
		// Completion changes the existing chat's result without another badge count or bounce.
		expect(invoke.mock.calls.filter(([channel]) => channel === "app:attention")).toEqual([
			["app:attention", { count: 1, alert: true, overlay: null }],
			["app:attention", { count: 2, alert: true, overlay: null }],
		]);
		expect(invoke.mock.calls.filter(([channel]) => channel === "app:notify")).toHaveLength(3);
		expect(rendered).toHaveBeenCalledTimes(rendersBeforeHiddenEvents);
		expect(container.textContent).toBe("question:workingapproval:working");
		expect(question.getSnapshot().working).toBe(false);
		expect(approval.getSnapshot().guest?.uiRequest).toBe(approvalRequest);

		// Being shown, or receiving a focus event while still hidden, acknowledges neither split half.
		await act(async () => {
			useApp.setState({ splitTabId: null });
			window.dispatchEvent(new Event("focus"));
		});
		expect(useApp.getState().unseenChats).toEqual({ question: "finished", approval: "needsInput" });
		focused = false;
		await setVisibility("visible");
		expect(container.textContent).toBe("question:liveapproval:needsInput");
		expect(useApp.getState().unseenChats).toEqual({ question: "finished", approval: "needsInput" });

		await act(async () => {
			focused = true;
			window.dispatchEvent(new Event("focus"));
		});
		expect(useApp.getState().unseenChats).toEqual({ approval: "needsInput" });
		expect(invoke).toHaveBeenLastCalledWith("app:attention", { count: 1, alert: false, overlay: null });
		// The native notification's click uses the installed IPC consumer and production tab activation.
		await act(async () => sendMain("app:openChat", { chatId: "approval" }));
		expect(useApp.getState().activeTabId).toBe("approval");
		expect(useApp.getState().unseenChats).toEqual({});
		expect(invoke).toHaveBeenLastCalledWith("app:attention", { count: 0, alert: false, overlay: null });
		expect(invoke.mock.calls.filter(([channel]) => channel === "app:notify")).toHaveLength(3);
	});
});
