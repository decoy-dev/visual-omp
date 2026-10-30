// @vitest-environment happy-dom
import type { SessionSummary } from "@shared/ipc";
import type * as MotionReact from "motion/react";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { ChatTab } from "../../state/app";
import { useApp } from "../../state/app";
import type { SessionView } from "../../state/session";
import { ProjectBoard } from "./ProjectBoard";

const fake = vi.hoisted(() => ({ controllers: new Map<string, { getSnapshot(): SessionView; subscribe(listener: () => void): () => void }>(), activate: vi.fn(), open: vi.fn() }));
vi.mock("../../state/app", async () => {
	// The hoisted factory must initialize its store before this test module's static imports.
	const { create } = await import("zustand");
	return { controllerFor: (id: string) => fake.controllers.get(id) ?? null, useApp: create(() => ({ tabs: [], unseenChats: {}, activateTab: fake.activate, openSession: fake.open })) };
});
vi.mock("motion/react", async importOriginal => {
	const actual = await importOriginal<typeof MotionReact>();
	// Motion's layout is exercised in Chrome; DOM tests render list changes synchronously.
	const { createElement, forwardRef } = await import("react");
	const primitive = (tag: "div" | "li" | "section") => forwardRef<HTMLElement, Record<string, unknown>>(({ children, ...props }, ref) => {
		const dom: Record<string, unknown> = { ref };
		for (const [key, value] of Object.entries(props)) if (key === "className" || key === "id" || key.startsWith("aria-")) dom[key] = value;
		return createElement(tag, dom, children as ReactNode);
	});
	const primitives = { div: primitive("div"), li: primitive("li"), section: primitive("section") };
	return { ...actual, motion: new Proxy(actual.motion, { get: (target, key) => key in primitives ? primitives[key as keyof typeof primitives] : Reflect.get(target, key) }), AnimatePresence: ({ children }: { children: ReactNode }) => children, LayoutGroup: ({ children }: { children: ReactNode }) => children };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const path = "/project";
let container: HTMLDivElement;
let root: Root;
const tabs: ChatTab[] = [{ id: "open", title: "Open draft", sessionFile: null, projectPath: path }];
const idle = { mode: "history", working: false, workingSince: null, readOnly: false, guest: null, history: null, host: null, error: null } as SessionView;
let snapshot: SessionView;
let listeners: Set<() => void>;
beforeEach(() => {
	fake.controllers.clear();
	fake.activate.mockClear();
	fake.open.mockClear();
	snapshot = idle;
	listeners = new Set();
	fake.controllers.set("open", { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } });
	useApp.setState({ tabs, unseenChats: {} });
	Object.assign(window, { vomp: { platform: "darwin" } });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render(sessions: SessionSummary[] | undefined, failed = false) {
	await act(async () => root.render(createElement(ProjectBoard, { path, sessions, failed })));
}
async function update(patch: Partial<SessionView>) {
	await act(async () => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); });
}

describe("project board rendered history states", () => {
	it.each([false, true])("retains and opens known idle tabs while saved history is unavailable (failed=%s)", async failed => {
		await render(undefined, failed);
		const row = container.querySelector<HTMLButtonElement>('button[aria-label^="Open draft."]');
		expect(row).not.toBeNull();
		expect(container.textContent).not.toContain("No chats in this project yet.");
		if (failed) expect(container.textContent).toContain("Couldn't read the saved chats");
		else expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		await act(async () => row!.click());
		expect(fake.activate).toHaveBeenCalledWith("open");
		expect(fake.open).not.toHaveBeenCalled();
	});

	it("keeps recent rows and their disclosure available while saved history loads", async () => {
		useApp.setState({ tabs: Array.from({ length: 7 }, (_, index) => ({ ...tabs[0], id: `open-${index}`, title: `Draft ${index}` })) });
		await render(undefined);
		expect(container.querySelectorAll("li")).toHaveLength(5);
		const disclosure = container.querySelector<HTMLButtonElement>('button[aria-controls]')!;
		expect(disclosure.textContent).toBe("Show all 7 chats");
		await act(async () => disclosure.click());
		expect(container.querySelectorAll("li")).toHaveLength(7);
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
	});

	it("uses a muted second line only when an unopened result has a current recap", async () => {
		useApp.setState({ unseenChats: { open: "finished" } });
		snapshot = { ...idle, host: { notices: [{ id: "recap", kind: "recap", timestamp: 100, text: "Continue with the next change." }] } as unknown as SessionView["host"] };
		await render([]);
		let row = container.querySelector<HTMLButtonElement>('button[aria-label^="Open draft."]')!;
		expect(row.classList.contains("min-h-12")).toBe(true);
		const detail = row.querySelector(".text-fg-muted")!;
		expect(detail.textContent).toBe("Continue with the next change.");
		expect(detail.previousElementSibling?.textContent).toBe("Open draft");
		await update({ host: null });
		row = container.querySelector<HTMLButtonElement>('button[aria-label^="Open draft."]')!;
		expect(row.classList.contains("h-10")).toBe(true);
		expect(row.querySelector(".text-fg-muted")).toBeNull();
	});
});

describe("project board rendered announcements", () => {
	it("announces an error as needing attention and uses the error fallback when omp supplies no detail", async () => {
		await render([]);
		expect(container.querySelector('[role="status"]')?.textContent).toBe("");
		await update({ mode: "live", host: { programStatus: { state: "error" } } as SessionView["host"] });
		expect(container.querySelector('[role="status"]')?.textContent).toBe("Open draft needs your attention");
		const row = container.querySelector<HTMLButtonElement>('button[aria-label^="Open draft."]')!;
		expect(row.querySelector(".text-fg-muted")?.textContent).toBe("Chat error");
		expect(row.getAttribute("aria-label")).not.toContain("waiting for your answer");
	});

	it("keeps initial errors silent and announces a later question once per episode", async () => {
		snapshot = { ...idle, error: "Connection failed" };
		await render([]);
		expect(container.querySelector('[role="status"]')?.textContent).toBe("");
		await update({ error: null });
		await update({ mode: "live", host: { programStatus: { state: "blocked", msg: "Can I continue?" } } as SessionView["host"] });
		const announcement = container.querySelector('[role="status"] p');
		expect(announcement?.textContent).toBe("Open draft is waiting for your answer");
		await update({ host: { programStatus: { state: "blocked", msg: "Updated question" } } as SessionView["host"] });
		expect(container.querySelector('[role="status"] p')).toBe(announcement);
		await update({ host: null });
		await update({ host: { programStatus: { state: "blocked", msg: "Can I continue?" } } as SessionView["host"] });
		expect(container.querySelector('[role="status"] p')).not.toBe(announcement);
	});
});
