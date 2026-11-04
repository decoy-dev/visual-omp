// @vitest-environment happy-dom
import { act, createElement, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../../i18n";
import type { SessionController } from "../../state/session";
import type { Helper } from "./derive";
import { HelperTranscriptDialog } from "./HelperStrip";

// Idle preloading would load the transcript dialog before the test fails it.
vi.mock("../../registry/idle", () => ({ preloadWhenIdle: () => {} }));
// The transcript dialog loads with the Tasks pane's chunk; this test makes that chunk fail.
vi.mock("./TasksPane", () => {
	throw new Error("Chunk unavailable");
});

const shell = import.meta.glob<{ load: Record<string, string> }>("../../i18n/en/shell.json", { eager: true, import: "default" })["../../i18n/en/shell.json"]!;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

/** Opens the transcript like the pinned helper strip does, and drops it when the dialog asks to close. */
function Strip(): ReactNode {
	const [open, setOpen] = useState(true);
	return open ? createElement(HelperTranscriptDialog, { helper: { id: "helper" } as Helper, session: {} as SessionController, onClose: () => setOpen(false) }) : createElement("p", null, "Strip");
}

it("shows the failure dialog when a helper's transcript does not load, and Close dismisses it", async () => {
	await act(async () => root.render(createElement(Strip)));
	await act(async () => {
		await HelperTranscriptDialog.preload().catch(() => {});
	});
	const dialog = document.querySelector("[role=dialog]");
	expect(dialog?.textContent).toContain(shell.load.failedTitle);
	expect([...dialog!.querySelectorAll("button")].map(button => button.textContent)).toContain(shell.load.retry);

	await act(async () => [...dialog!.querySelectorAll("button")].find(button => button.textContent === shell.load.close)!.click());
	expect(document.querySelector("[role=dialog]")).toBeNull();
	expect(container.textContent).toBe("Strip");
});
