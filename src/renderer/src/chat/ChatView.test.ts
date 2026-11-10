// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../state/session";
import "../i18n";
import type { Helper } from "../features/panes/derive";
import type * as UiModule from "../ui";

const actions = vi.hoisted(() => ({ newChat: vi.fn(), ensureLive: vi.fn(), restore: vi.fn(), retryFollowing: vi.fn(async () => {}) }));
const footer = vi.hoisted(() => ({ form: null as string | null }));
vi.mock("./transcript/formPresentation", () => ({ usePresentedForm: () => footer.form }));
vi.mock("../ui", async importOriginal => {
	const actual = await importOriginal<typeof UiModule>();
	// vi.mock is hoisted before static React imports initialize.
	const { createElement } = await import("react");
	return { ...actual, Expand: ({ open, instant = false, children }: { open: boolean; instant?: boolean; children: ReactNode }) => createElement("div", { "data-footer-open": open, "data-footer-instant": instant }, open ? children : null) };
});
vi.mock("../registry/slots", () => ({ chatSlots: { use: () => [] } }));
vi.mock("../shell/hooks", () => ({ elapsed: () => "0s", useNow: () => 0, chatActivityKey: () => "activity.thinking", useSessionView: vi.fn() }));
vi.mock("../state/app", () => ({ useApp: { getState: () => ({ newChat: actions.newChat }) } }));
vi.mock("./composer/Composer", () => ({ Composer: () => null }));
vi.mock("./SessionHeader", () => ({ SessionHeader: () => null }));
vi.mock("./transcript/Transcript", () => ({ Transcript: () => null }));

import { HelperFocusPending, StateBanner, WorkingStatus } from "./ChatView";

let element: HTMLDivElement;
let root: Root;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	actions.newChat.mockClear(); actions.ensureLive.mockClear(); actions.restore.mockClear(); actions.retryFollowing.mockClear();
	footer.form = null;
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	element.remove();
});

async function render(reason: string | null, missing = false, error: string | null = null, restore = false, transport?: "tsp") {
	const session = { projectPath: "/chosen/folder", ensureLive: actions.ensureLive, restore: actions.restore } as unknown as SessionController;
	const view = { mode: "exited", readOnly: false, error, host: { transport, exitCode: 1, exitReason: reason, resumeFileMissing: missing, restoreAvailable: restore } } as SessionView;
	await act(async () => root.render(createElement(StateBanner, { session, view })));
}

async function clickButton(name: string) {
	const button = [...element.querySelectorAll("button")].find(button => (button.getAttribute("aria-label") ?? button.textContent) === name);
	expect(button, `Button named ${name}`).toBeDefined();
	expect(button!.disabled).toBe(false);
	await act(async () => button!.click());
}

describe("startup exit banner", () => {
	it.each([undefined, "tsp"] as const)("shows the missing session path and starts a fresh chat in the same folder (%s)", async transport => {
		await render("Session file not found: /chosen/folder/missing.jsonl", true, null, false, transport);
		expect(element.textContent).toContain("Session file not found: /chosen/folder/missing.jsonl");
		expect(element.textContent).not.toContain("Start omp again");
		await clickButton("Start a fresh chat");
		expect(actions.newChat).toHaveBeenCalledExactlyOnceWith("/chosen/folder");
		expect(actions.ensureLive).not.toHaveBeenCalled();
		expect(actions.restore).not.toHaveBeenCalled();
	});

	it.each([undefined, "tsp"] as const)("shows the named model error and restarts the same chat (%s)", async transport => {
		await render("Model unavailable: provider/model-name\nretry.modelFallback is disabled.", false, null, false, transport);
		expect(element.textContent).toContain("provider/model-name");
		expect(element.textContent).toContain("retry.modelFallback is disabled.");
		expect(element.textContent).not.toContain("Start a fresh chat");
		await clickButton("Start omp again");
		expect(actions.ensureLive).toHaveBeenCalledOnce();
		expect(actions.newChat).not.toHaveBeenCalled();
		expect(actions.restore).not.toHaveBeenCalled();
	});

	it("keeps a launch error when no terminal reason was reported", async () => {
		await render(null, false, "Permission denied");
		expect(element.textContent).toContain("Permission denied");
	});
});

it("offers explicit crash recovery without silently choosing it for an ordinary restart", async () => {
	await render(null, false, null, true);
	await clickButton("Continue where omp stopped");
	expect(actions.restore).toHaveBeenCalledOnce();
	expect(actions.ensureLive).not.toHaveBeenCalled();
	expect(actions.newChat).not.toHaveBeenCalled();
});

it("offers a reader retry while a saved chat remains read-only", async () => {
	const retry = Promise.withResolvers<void>();
	actions.retryFollowing.mockReturnValueOnce(retry.promise);
	const session = { retryFollowing: actions.retryFollowing } as unknown as SessionController;
	const view = { mode: "history", readOnly: true, follow: { readable: false, ownership: "unknown", error: "Reader chunk unavailable" } } as SessionView;
	await act(async () => root.render(createElement(StateBanner, { session, view })));
	await clickButton("Try following again");
	const button = [...element.querySelectorAll("button")].find(button => button.textContent === "Try following again")!;
	expect(button.disabled).toBe(true);
	expect(element.textContent).toContain("Reader chunk unavailable");
	expect(actions.retryFollowing).toHaveBeenCalledOnce();
	await act(async () => retry.resolve());
	expect(button.disabled).toBe(false);
	expect(actions.ensureLive).not.toHaveBeenCalled();
});

it.each([false, true])("keeps the helper banner and return target while its chunk is loading or failed (failed=%s)", async failed => {
	const retry = vi.fn();
	const session = { tabId: "helper-pending" } as unknown as SessionController;
	const helper = { id: "Atlas", name: "Atlas", status: "running" } as Helper;
	await act(async () => root.render(createElement(HelperFocusPending, { session, helper, parentTitle: "Checkout fixes", retry: failed ? retry : undefined })));
	expect(element.querySelector("[data-helper-banner]")?.textContent).toContain("Helper conversation with Atlas");
	expect(element.textContent).toContain("From chat: Checkout fixes");
	const back = element.querySelector<HTMLButtonElement>('[aria-label="Back to Checkout fixes"]')!;
	expect(document.activeElement).toBe(back);
	if (failed) {
		const button = [...element.querySelectorAll("button")].find(candidate => candidate.textContent === "Try again")!;
		await act(async () => button.click());
		expect(retry).toHaveBeenCalledOnce();
	}
});

it("holds the working row through native-held closing and keeps its departure geometry instant across updates", async () => {
	const session = {} as SessionController;
	let view: SessionView = { mode: "live", readOnly: false, working: true, workingSince: null, follow: null, ownerUnverified: false, guest: null, history: null, carryover: null, displayLeaf: null, inputHistory: [], queue: [], strandedImages: false, host: { hostId: "form-host", generation: 1, transport: "tsp" } as SessionView["host"], error: null };
	const stopFocus = { current: false };
	footer.form = "presented-form";
	await act(async () => root.render(createElement(WorkingStatus, { view, session, activity: null, stopFocus })));
	expect(element.querySelector("[data-footer-open]")?.getAttribute("data-footer-open")).toBe("false");
	footer.form = null;
	await act(async () => root.render(createElement(WorkingStatus, { view, session, activity: null, stopFocus })));
	expect(element.querySelector("[data-footer-open]")?.getAttribute("data-footer-open")).toBe("true");
	expect(element.querySelector("[data-footer-instant]")?.getAttribute("data-footer-instant")).toBe("true");
	view = { ...view, workingSince: 0 };
	await act(async () => root.render(createElement(WorkingStatus, { view, session, activity: null, stopFocus })));
	expect(element.querySelector("[data-footer-instant]")?.getAttribute("data-footer-instant")).toBe("true");
	view = { ...view, working: false };
	await act(async () => root.render(createElement(WorkingStatus, { view, session, activity: null, stopFocus })));
	view = { ...view, working: true };
	await act(async () => root.render(createElement(WorkingStatus, { view, session, activity: null, stopFocus })));
	expect(element.querySelector("[data-footer-instant]")?.getAttribute("data-footer-instant")).toBe("false");
});

it("resets working-row departure geometry when the host generation changes", async () => {
	const session = {} as SessionController;
	const view: SessionView = { mode: "live", readOnly: false, working: true, workingSince: null, follow: null, ownerUnverified: false, guest: null, history: null, carryover: null, displayLeaf: null, inputHistory: [], queue: [], strandedImages: false, host: { hostId: "form-host", generation: 1, transport: "tsp" } as SessionView["host"], error: null };
	const stopFocus = { current: false };
	footer.form = "presented-form";
	await act(async () => root.render(createElement(WorkingStatus, { view, session, activity: null, stopFocus })));
	footer.form = null;
	await act(async () => root.render(createElement(WorkingStatus, { view: { ...view, host: { ...view.host!, generation: 2 } }, session, activity: null, stopFocus })));
	expect(element.querySelector("[data-footer-open]")?.getAttribute("data-footer-open")).toBe("true");
	expect(element.querySelector("[data-footer-instant]")?.getAttribute("data-footer-instant")).toBe("false");
});

it("keeps instant departure when the native form leaves before the tool result", async () => {
	const session = {} as SessionController;
	let view = { mode: "live", readOnly: false, working: true, workingSince: null, host: { hostId: "form-host", generation: 1, transport: "tsp" }, guest: {
		phase: "live", readOnly: false, working: true, uiRequest: null, entries: [], stream: null,
		activeTools: new Map([["call", { toolCallId: "call", toolName: "ask", args: { html: '<form><input name="answer"></form>' } }]]),
	} } as unknown as SessionView;
	const stopFocus = { current: false };
	footer.form = "native-form";
	await act(async () => root.render(createElement(WorkingStatus, { view, session, activity: null, stopFocus })));
	footer.form = null;
	await act(async () => root.render(createElement(WorkingStatus, { view, session, activity: null, stopFocus })));
	expect(element.querySelector("[data-footer-open]")?.getAttribute("data-footer-open")).toBe("false");
	view = { ...view, guest: { ...view.guest!, working: false, activeTools: new Map() } };
	await act(async () => root.render(createElement(WorkingStatus, { view, session, activity: null, stopFocus })));
	expect(element.querySelector("[data-footer-open]")?.getAttribute("data-footer-open")).toBe("true");
	expect(element.querySelector("[data-footer-instant]")?.getAttribute("data-footer-instant")).toBe("true");
});
