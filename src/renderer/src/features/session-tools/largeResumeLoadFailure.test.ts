// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../../i18n";
import type { ResumeRequest } from "../../registry/guards";
import { askLargeResume, LargeResumeHost, useLargeResume } from "./largeResume";

// Idle preloading would load the dialog before the test fails it.
vi.mock("../../registry/idle", () => ({ preloadWhenIdle: () => {} }));
// The warning dialog loads from its own chunk; this test makes that chunk fail.
vi.mock("./LargeResumeDialog", () => {
	throw new Error("Chunk unavailable");
});

const shell = import.meta.glob<{ load: Record<string, string> }>("../../i18n/en/shell.json", { eager: true, import: "default" })["../../i18n/en/shell.json"]!;

let element: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	useLargeResume.setState({ pending: null });
});

afterEach(async () => {
	await act(async () => root.unmount());
	element.remove();
});

const request: ResumeRequest = { tabId: "a", projectPath: "/projects/a", file: "/sessions/a.jsonl", bytes: 70_531_373, signal: new AbortController().signal };

it("shows the failure dialog when the warning does not load, and Close answers no instead of leaving the chat waiting", async () => {
	const answered = askLargeResume(request);
	await act(async () => {
		root.render(createElement(LargeResumeHost));
		await import("./LargeResumeDialog").catch(() => {});
	});
	const dialog = document.querySelector("[role=dialog]");
	expect(dialog?.textContent).toContain(shell.load.failedTitle);
	expect([...dialog!.querySelectorAll("button")].map(button => button.textContent)).toContain(shell.load.retry);

	await act(async () => [...dialog!.querySelectorAll("button")].find(button => button.textContent === shell.load.close)!.click());
	await expect(answered).resolves.toBe(false);
	expect(useLargeResume.getState().pending).toBeNull();
	expect(document.querySelector("[role=dialog]")).toBeNull();
});
