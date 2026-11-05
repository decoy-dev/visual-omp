// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSubject } from "../types";
import { Frame } from "./html";
import copy from "../../../i18n/en/panes.json";
const events = vi.hoisted(() => ({ listeners: new Map<string, (value: { token: string; url: string }) => void>(), toast: vi.fn() }));
vi.mock("../../../ui/toast", () => ({ toast: events.toast }));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => {
	let value: unknown = copy;
	for (const part of key.split(".")) value = (value as Record<string, unknown>)?.[part];
	return String(value ?? key);
} }) }));

let host: HTMLDivElement;
let root: Root;
const invoke = vi.fn();
function subject(overrides: Partial<LiveSubject> = {}): LiveSubject {
	return { id: "call:page", kind: "source", format: "html", toolCallId: "page", toolName: "write", path: "/project/page.html", text: "<h1>First</h1>", revision: 1, state: "writing", elided: false, intent: null, request: null, images: null, progress: null, sequence: null, size: 14, startedAt: 1, updatedAt: 1, ...overrides };
}
async function show(current = subject(), strict = false) {
	await act(async () => {
		const frame = createElement(Frame, { subject: current, projectPath: "/project", related: ["/project/style.css"] });
		root.render(strict ? createElement(StrictMode, null, frame) : frame);
	});
	await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	host = document.createElement("div");
	// Happy-dom has no custom-protocol handler. Keep frames detached and dispatch their load events explicitly.
	root = createRoot(host);
	invoke.mockReset();
	events.listeners.clear();
	events.toast.mockReset();
	invoke.mockImplementation(async (channel: string) => channel === "preview:grant" ? { token: "token", url: "vomp-preview://token/page.html", assetRoot: true } : channel === "preview:prepare" ? { ok: true } : undefined);
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke, on: (event: string, listener: (value: { token: string; url: string }) => void) => {
		events.listeners.set(event, listener);
		return () => events.listeners.delete(event);
	} } });
});
afterEach(async () => {
	await act(async () => { root.unmount(); });
	host.remove();
	vi.useRealTimers();
});

describe("HTML preview grants", () => {
	it("grants on mount, publishes text before loading and revokes on unmount", async () => {
		await show();
		expect(invoke).toHaveBeenCalledWith("preview:grant", { path: "/project/page.html", root: "/project", related: ["/project/style.css"] });
		expect(invoke).toHaveBeenCalledWith("preview:live", "token", 1, "<h1>First</h1>");
		const iframe = host.querySelector("iframe");
		expect(iframe?.getAttribute("src")).toBe("vomp-preview://token/page.html?rev=1");
		expect(iframe?.getAttribute("sandbox")).toBe("");
		await act(async () => { root.unmount(); });
		expect(invoke).toHaveBeenCalledWith("preview:revoke", "token");
		root = createRoot(host);
	});
	it("explains disabled scripts and network access", async () => {
		await show(subject({ kind: "file", state: "saved", text: null }));
		expect(host.textContent).toContain("Scripts and network access are off. Interactive features may not work.");
	});

	it("offers browser navigation for only its own grant without the live tracker", async () => {
		await show(subject({ kind: "file", state: "saved", text: null }));
		const navigate = events.listeners.get("preview:blockedNavigation")!;
		navigate({ token: "another", url: "https://example.com/" });
		expect(events.toast).not.toHaveBeenCalled();
		navigate({ token: "token", url: "https://example.com/" });
		expect(events.toast).toHaveBeenCalledOnce();
		events.toast.mock.calls[0][0].action.onClick();
		expect(invoke).toHaveBeenCalledWith("app:openExternal", "https://example.com/");
	});

	it("permits fixture scripts only when main's prepared revision carries the test flag", async () => {
		await show();
		const first = host.querySelector("iframe")!;
		expect(first.getAttribute("sandbox")).toBe("");
		await act(() => first.dispatchEvent(new Event("load")));
		invoke.mockImplementation(async (channel: string) => channel === "preview:prepare" ? { ok: true, isolationTest: true } : undefined);
		await show(subject({ state: "saved" }));
		expect(host.querySelectorAll("iframe")).toHaveLength(1);
		const scripted = host.querySelector("iframe")!;
		expect(scripted).not.toBe(first);
		expect(scripted.getAttribute("sandbox")).toBe("allow-scripts");
		expect(scripted.getAttribute("sandbox")).not.toContain("allow-same-origin");
	});

	it("coalesces streaming writes to at most four per second and still publishes the final revision", async () => {
		await show();
		await show(subject({ revision: 2, text: "<h1>Second</h1>" }));
		await act(async () => { await vi.advanceTimersByTimeAsync(100); });
		await show(subject({ revision: 3, text: "<h1>Third</h1>" }));
		expect(invoke.mock.calls.filter(call => call[0] === "preview:live")).toHaveLength(1);
		await act(async () => { await vi.advanceTimersByTimeAsync(150); });
		expect(invoke.mock.calls.filter(call => call[0] === "preview:live")).toEqual([["preview:live", "token", 1, "<h1>First</h1>"], ["preview:live", "token", 3, "<h1>Third</h1>"]]);
	});

	it("switches to disk once on save and never sends more streamed text afterwards", async () => {
		await show();
		await show(subject({ state: "saved", revision: 2, text: "<h1>Saved</h1>" }));
		await show(subject({ state: "saved", revision: 3, text: "<h1>Saved</h1>" }));
		expect(invoke.mock.calls.filter(call => call[0] === "preview:saved")).toEqual([["preview:saved", "token"]]);
		expect(invoke.mock.calls.filter(call => call[0] === "preview:live")).toHaveLength(1);
	});

	it("retains the visible revision until its replacement frame has loaded", async () => {
		await show();
		await act(() => host.querySelector("iframe")?.dispatchEvent(new Event("load")));
		const first = host.querySelector("iframe");
		expect(first?.style.visibility).toBe("visible");
		await act(async () => { await vi.advanceTimersByTimeAsync(250); });
		await show(subject({ revision: 2, text: "<h1>Second</h1>" }));
		const frames = [...host.querySelectorAll("iframe")];
		expect(frames).toHaveLength(2);
		expect(frames[0].style.visibility).toBe("visible");
		expect(frames[1].style.visibility).toBe("hidden");
		await act(() => frames[1].dispatchEvent(new Event("load")));
		expect(frames[0].style.visibility).toBe("hidden");
		expect(frames[1].style.visibility).toBe("visible");
	});

	it.each(["missing", "tooLarge", "notFile", "revoked"])("keeps the good frame when preparing a saved document reports %s, then recovers on the next valid save", async reason => {
		await show();
		await act(() => host.querySelector("iframe")?.dispatchEvent(new Event("load")));
		const first = host.querySelector("iframe")!;
		invoke.mockImplementation(async (channel: string) => channel === "preview:prepare" ? { ok: false, reason } : undefined);
		await show(subject({ kind: "file", state: "saved", text: null, revision: 2 }));
		expect(host.querySelectorAll("iframe")).toHaveLength(1);
		expect(first.src).toBe("vomp-preview://token/page.html?rev=1");
		expect(first.style.visibility).toBe("visible");
		expect(host.textContent).toContain("Waiting for omp to finish saving");
		invoke.mockImplementation(async (channel: string) => channel === "preview:prepare" ? { ok: true } : undefined);
		await show(subject({ kind: "file", state: "saved", text: null, revision: 3 }));
		const next = [...host.querySelectorAll("iframe")].find(frame => frame !== first)!;
		expect(next.src).toBe("vomp-preview://token/page.html?rev=3");
		expect(first.style.visibility).toBe("visible");
		await act(() => next.dispatchEvent(new Event("load")));
		expect(first.style.visibility).toBe("hidden");
		expect(next.style.visibility).toBe("visible");
		expect(host.textContent).not.toContain("Waiting for omp to finish saving");
	});

	it("does not load a revision until its snapshot is prepared", async () => {
		const prepared = Promise.withResolvers<{ ok: true }>();
		invoke.mockImplementation(async (channel: string) => channel === "preview:grant" ? { token: "token", url: "vomp-preview://token/page.html", assetRoot: true } : channel === "preview:prepare" ? prepared.promise : undefined);
		await show();
		expect(host.querySelector("iframe")).toBeNull();
		await act(async () => { prepared.resolve({ ok: true }); });
		expect(host.querySelector("iframe")?.src).toBe("vomp-preview://token/page.html?rev=1");
	});

	it("shows the restricted-assets notice only when the grant has no asset root", async () => {
		invoke.mockImplementation(async (channel: string) => channel === "preview:grant" ? { token: "token", url: "vomp-preview://token/page.html", assetRoot: false } : channel === "preview:prepare" ? { ok: true } : undefined);
		await show();
		expect(host.textContent).toContain("Some assets may be unavailable. This preview can load only files named in this turn.");
	});

	it("omits the restricted-assets notice when the project assets are granted", async () => {
		await show();
		expect(host.textContent).not.toContain("Some assets may be unavailable.");
	});

	it("revokes grants that finish after the frame unmounts", async () => {
		const grant = Promise.withResolvers<{ token: string; url: string; assetRoot: boolean }>();
		invoke.mockImplementation((channel: string) => channel === "preview:grant" ? grant.promise : Promise.resolve());
		await show();
		await act(async () => { root.unmount(); });
		await act(async () => { grant.resolve({ token: "late", url: "vomp-preview://late/page.html", assetRoot: true }); });
		expect(invoke).toHaveBeenCalledWith("preview:revoke", "late");
		expect(invoke.mock.calls.some(call => call[0] === "preview:live")).toBe(false);
		root = createRoot(host);
	});
});
