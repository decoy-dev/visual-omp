// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPreferences } from "@shared/ipc";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { SubjectInput } from "./subjects";
import type * as Subjects from "./subjects";
import type * as PanesDerive from "../panes/derive";
import { Frame as MarkdownFrame } from "./formats/markdown";
import type { SessionController, SessionView } from "../../state/session";
import type { LiveFrameProps, LiveSubject } from "./types";

const env = vi.hoisted(() => ({
	subjects: [] as LiveSubject[], sessions: new Map<string, SessionController>(), showPane: vi.fn(), invoke: vi.fn(), listeners: new Map<string, (value: unknown) => void>(),
	loadAdapter: vi.fn(),
}));
vi.mock("../../state/app", async () => {
	// The mock factory runs before this test module's imports.
	const { create } = await import("zustand");
	return {
		useApp: create(() => ({ prefs: { livePreview: true, livePreviewOpenOutputs: false }, tabs: [{ id: "chat" }], showPane: env.showPane })),
		controllerFor: (id: string) => env.sessions.get(id),
	};
});
vi.mock("react-i18next", async () => {
	const panes = (await import("../../i18n/en/panes.json")).default;
	const shell = (await import("../../i18n/en/shell.json")).default;
	return { useTranslation: (namespace = "panes") => ({ t: (key: string, values?: Record<string, unknown>) => {
		let value: unknown = namespace === "shell" ? shell : panes;
		for (const part of key.split(".")) value = (value as Record<string, unknown>)?.[part];
		return String(value ?? key).replace(/{{(\w+)}}/g, (_, name: string) => String(values?.[name] ?? ""));
	} }) };
});
vi.mock("../../ui", () => ({
	cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
	Button: ({ children, icon: _icon, variant: _variant, size: _size, ...props }: { children?: ReactNode; icon?: ReactNode; variant?: string; size?: string }) => createElement("button", props, children),
	Notice: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => createElement("div", { role: "status" }, children, actions),
	IconButton: ({ label, icon: _icon, size: _size, ...props }: { label: string; icon?: ReactNode; size?: string }) => createElement("button", { ...props, "aria-label": label }, label),
	Menu: ({ children }: { children: ReactNode }) => children,
	MenuTrigger: ({ children }: { children: ReactNode }) => children,
	MenuContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
	MenuItem: ({ children, onSelect, disabled }: { children: ReactNode; onSelect(): void; disabled?: boolean }) => createElement("button", { onClick: onSelect, disabled }, children),
}));
vi.mock("../panes/common", () => ({ FileName: ({ name }: { name: string }) => name }));
vi.mock("../panes/files-store", () => ({ openInFiles: vi.fn() }));
vi.mock("../panes/media", () => ({ ExpandPreview: () => null, PdfFrame: () => null, PreviewImage: () => null, loadFileImage: vi.fn() }));
vi.mock("../panes/derive", async importOriginal => ({ ...await importOriginal<typeof PanesDerive>(), backgroundJobs: () => [], ompRunning: () => true }));
vi.mock("./subjects", () => ({ deriveSubjects: () => env.subjects, namedPaths: () => [], relatedPaths: () => [] }));
vi.mock("./formats", () => ({ loadAdapter: (format: string) => env.loadAdapter(format) }));
vi.mock("../../i18n", () => ({ retryFailedNamespaces: async () => {} }));
vi.mock("../../transcript/Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("div", null, text) }));
vi.mock("../../ui/toast", () => ({ toast: vi.fn() }));
import { useApp } from "../../state/app";
import { notifyComposerAction, registerComposerEditor, useComposerDrafts } from "../../chat/composer/drafts";
import { Stage } from "./Stage";
import { Tracker } from "./Tracker";
import { useLivePreview } from "./store";
import { cancelPreviewRedirect, usePreviewRedirect } from "./redirect";

let element: HTMLDivElement;
let root: Root;
let working: boolean;
let snapshotListeners: Set<() => void>;
let session: SessionController;
let held: boolean;
let focus = vi.fn<() => void>();
let unregister: () => void;
const subject = (id: string, text = id, state: LiveSubject["state"] = "writing"): LiveSubject => ({ id, text, state, kind: "source", format: "svg", path: `/project/${id}.svg`, toolCallId: id, toolName: "write", revision: 1, elided: false, intent: null, request: null, images: null, size: text.length, startedAt: Date.now(), updatedAt: Date.now() });
const render = async (tracker = false) => { await act(async () => root.render(createElement("div", null, tracker && createElement(Tracker), createElement(Stage, { session, onShowOutput: vi.fn() })))); };
const click = async (label: string) => { const button = [...element.querySelectorAll("button")].find(value => value.textContent === label)!; expect(button).toBeTruthy(); await act(async () => button.click()); };
const changeWorking = async (value: boolean) => { await act(async () => { working = value; for (const listener of snapshotListeners) listener(); }); };

beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	env.showPane.mockReset(); env.invoke.mockReset(); env.listeners.clear(); env.subjects = [subject("one")];
	env.loadAdapter.mockReset().mockImplementation(async (format: string) => ({ maxFps: 8, format, Frame: format === "markdown" ? MarkdownFrame : ({ subject }: LiveFrameProps) => createElement("div", { "data-frame": "" }, subject.text) }));
	env.invoke.mockImplementation(async (channel: string) => channel === "preview:watch" ? "watch" : undefined);
	Object.assign(window, { vomp: { invoke: env.invoke, on: (channel: string, listener: (value: unknown) => void) => { env.listeners.set(channel, listener); return () => env.listeners.delete(channel); } } });
	working = true; held = false; snapshotListeners = new Set(); focus = vi.fn();
	session = { tabId: "chat", projectPath: "/project", abort: vi.fn(), holdQueue: (promise: Promise<unknown>) => { held = true; void promise.then(() => { held = false; }); }, subscribe: (listener: () => void) => { snapshotListeners.add(listener); return () => { snapshotListeners.delete(listener); }; }, getSnapshot: () => ({ working, guest: null, mode: "live", host: null } as SessionView) } as unknown as SessionController;
	env.sessions.set("chat", session);
	useApp.setState({ prefs: { livePreview: true, livePreviewOpenOutputs: false } as AppPreferences });
	useLivePreview.setState({ chats: {} }); usePreviewRedirect.setState({}, true);
	useLivePreview.getState().update("chat", env.subjects, []);
	useComposerDrafts.setState({ drafts: { chat: "Keep my correction" }, previews: {}, attachments: { chat: [{ path: "/image.png", name: "image.png" }] } });
	unregister = registerComposerEditor("chat", { insertAtCaret: vi.fn(), focus });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => { cancelPreviewRedirect("chat"); root.unmount(); }); unregister(); element.remove(); vi.useRealTimers(); });

describe("Stop and redirect", () => {
	it.each(["send", "Escape"])("preserves text and attachments and holds the queue until %s in that composer", async () => {
		await render(); await click("Stop and redirect");
		expect(session.abort).toHaveBeenCalledOnce(); expect(held).toBe(true); expect(element.textContent).toContain("Stopping…");
		expect(useComposerDrafts.getState().drafts.chat).toBe("Keep my correction");
		await changeWorking(false);
		expect(useComposerDrafts.getState().drafts.chat).toBe("About one.svg: Keep my correction");
		expect(useComposerDrafts.getState().attachments.chat).toEqual([{ path: "/image.png", name: "image.png" }]); expect(focus).toHaveBeenCalledOnce(); expect(held).toBe(true);
		await act(async () => notifyComposerAction("other")); expect(held).toBe(true);
		await act(async () => notifyComposerAction("chat")); expect(held).toBe(false);
	});
	it("releases the queue after ten seconds without stop confirmation and offers Stop again", async () => {
		await render(); await click("Stop and redirect");
		await act(async () => vi.advanceTimersByTimeAsync(10_000));
		expect(held).toBe(false); expect(element.textContent).toContain("omp did not stop"); expect(useComposerDrafts.getState().drafts.chat).toBe("Keep my correction");
		await click("Stop"); expect(session.abort).toHaveBeenCalledTimes(2);
	});
});

it("keeps a selected subject while other outputs update, then retains its ended frame and label", async () => {
	const one = subject("one"); const two = subject("two");
	useLivePreview.getState().update("chat", [two, one], []); await render(); await click("one.svg");
	await act(async () => { useLivePreview.getState().update("chat", [{ ...two, revision: 2, text: "new two" }, one], []); });
	await act(async () => vi.advanceTimersByTimeAsync(125));
	expect(element.querySelector("[data-frame]")?.textContent).toBe("one");
	await act(async () => useLivePreview.getState().update("chat", [two, { ...one, state: "stopped" }], []));
	await act(async () => vi.advanceTimersByTimeAsync(125));
	expect(element.querySelector("[data-frame]")?.textContent).toBe("one"); expect(element.textContent).toContain("Stopped");
	await act(async () => useLivePreview.getState().update("chat", [subject("three")], []));
	expect(element.querySelector("[data-frame]")?.textContent).toBe("one");
});

it("keeps the older chip selected through elision and displays its saved file", async () => {
	// Import the real derivation past the Tracker mock to exercise the selection cutover end to end.
	const { deriveSubjects } = await vi.importActual<typeof Subjects>("./subjects");
	const assistant = (id: string, path: string, content: string, timestamp: number): AssistantMessage => ({
		role: "assistant", content: [{ type: "toolCall", id, name: "write", arguments: { path, content } }], timestamp, stopReason: "toolUse", model: "fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	});
	const entry = (message: AssistantMessage): SessionEntry => ({ type: "message", id: String(message.timestamp), parentId: null, timestamp: new Date(message.timestamp).toISOString(), message });
	const older = assistant("older", "older.md", "First draft", 200);
	const newer = assistant("newer", "newer.md", "Newer draft", 400);
	const snapshot: SubjectInput = { stream: null, streamDone: true, activeTools: new Map(), backgroundTools: new Map(), entries: [entry(older), entry(newer)], changes: [], working: true, folder: "/project", now: 1000 };
	let subjects = deriveSubjects(snapshot, []);
	useLivePreview.getState().update("chat", subjects, []);
	await render();
	await click("older.md");
	expect(element.textContent).toContain("First draft");
	const elided = assistant("older", "older.md", "First draft…[200000 chars elided for collab session]", 200);
	subjects = deriveSubjects({ ...snapshot, entries: [entry(elided), entry(newer)] }, subjects);
	await act(async () => useLivePreview.getState().update("chat", subjects, []));
	await act(async () => vi.advanceTimersByTimeAsync(125));
	expect(element.textContent).toContain("This file is too large to preview while omp writes it.");
	const saved: SessionEntry = { type: "message", id: "saved", parentId: null, timestamp: new Date(600).toISOString(), message: { role: "toolResult", toolCallId: "older", toolName: "write", content: [], isError: false, timestamp: 600 } };
	env.invoke.mockImplementation(async (channel: string) => channel === "panes:readFile" ? { kind: "text", text: "Complete saved document" } : undefined);
	subjects = deriveSubjects({ ...snapshot, entries: [entry(elided), entry(newer), saved] }, subjects);
	await act(async () => useLivePreview.getState().update("chat", subjects, []));
	await act(async () => vi.advanceTimersByTimeAsync(125));
	expect(element.textContent).toContain("Complete saved document");
	expect(element.textContent).not.toContain("This file is too large to preview while omp writes it.");
	const selected = [...element.querySelectorAll("button[aria-pressed='true']")].map(button => button.textContent);
	expect(selected).toEqual(["older.md"]);
});

it("announces state changes without repeating changing intent and size", async () => {
	await render();
	const announcements = () => [...element.querySelectorAll("[role='status']")].map(node => node.textContent);
	expect(announcements()).toEqual(["Writing"]);
	await act(async () => useLivePreview.getState().update("chat", [{ ...env.subjects[0], revision: 2, intent: "Refining the layout", size: 2048 }], []));
	expect(element.textContent).toContain("Refining the layout");
	expect(element.textContent).toContain("2 KB");
	expect(announcements()).toEqual(["Writing"]);
	await act(async () => useLivePreview.getState().update("chat", [{ ...env.subjects[0], state: "saved" }], []));
	expect(announcements()).toEqual(["Saved"]);
});

it.each([false, true])("auto-opens only when its preference is %s", async enabled => {
	useApp.setState({ prefs: { livePreview: true, livePreviewOpenOutputs: enabled } as AppPreferences });
	await render(true); await act(async () => vi.advanceTimersByTimeAsync(200));
	expect(env.showPane.mock.calls).toEqual(enabled ? [["outputs", "chat"]] : []);
	await act(async () => { for (const listener of snapshotListeners) listener(); await vi.advanceTimersByTimeAsync(200); });
	expect(env.showPane).toHaveBeenCalledTimes(enabled ? 1 : 0);
});

it("stops the watcher and hides the stage when the setting is turned off", async () => {
	await render(true); await act(async () => vi.advanceTimersByTimeAsync(200));
	expect(env.invoke).toHaveBeenCalledWith("preview:watch", { folder: "/project", named: [] });
	await act(async () => useApp.setState({ prefs: { livePreview: false, livePreviewOpenOutputs: false } as AppPreferences }));
	expect(env.invoke).toHaveBeenCalledWith("preview:unwatch", "watch"); expect(element.querySelector("section")).toBeNull();
});

describe("Adapter load recovery", () => {
	it("loads the adapter after Try again without remounting the stage", async () => {
		env.loadAdapter.mockRejectedValueOnce(new Error("Chunk unavailable"));
		await render();
		expect(element.querySelector("[data-frame]")).toBeNull();
		expect(element.textContent).toContain("Couldn't load this part of visual-omp");
		await click("Try again");
		expect(env.loadAdapter).toHaveBeenCalledTimes(2);
		expect(element.querySelector("[data-frame]")?.textContent).toBe("one");
		expect(element.textContent).not.toContain("Try again");
	});

	it("retries a failed adapter when the subject changes revision, then keeps the loaded adapter", async () => {
		env.loadAdapter.mockRejectedValueOnce(new Error("Chunk unavailable"));
		await render();
		expect(element.textContent).toContain("Try again");
		await act(async () => useLivePreview.getState().update("chat", [{ ...env.subjects[0], revision: 2, text: "Updated preview" }], []));
		expect(env.loadAdapter).toHaveBeenCalledTimes(2);
		expect(element.querySelector("[data-frame]")?.textContent).toBe("Updated preview");
		await act(async () => useLivePreview.getState().update("chat", [{ ...env.subjects[0], revision: 3, text: "Latest preview" }], []));
		await act(async () => vi.advanceTimersByTimeAsync(125));
		expect(element.querySelector("[data-frame]")?.textContent).toBe("Latest preview");
		expect(env.loadAdapter).toHaveBeenCalledTimes(2);
	});
});
