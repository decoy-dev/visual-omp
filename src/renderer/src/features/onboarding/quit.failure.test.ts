// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { confirmCloseAllTabs, QuitDialog, useQuitRequest } from "./quit";
import "../../i18n";

vi.hoisted(() => { Object.assign(window, { vomp: { platform: "darwin" } }); });
vi.mock("../../state/app", () => ({
	MAIN_ID: "vo-main", allControllers: () => [], controllerFor: () => null, whenHostsAdopted: () => Promise.resolve(),
	useApp: { getState: () => ({ tabs: [{ id: "saved", title: "Saved chat", sessionFile: "/saved.jsonl" }] }) },
}));
vi.mock("../../chat/composer/drafts", () => ({ useComposerDrafts: { getState: () => ({ drafts: {}, attachments: {} }) } }));
// The deferred dialog module fails to load; the eager failure view must retain cancellation and focus return.
vi.mock("./QuitDialog", () => { throw new Error("Dialog chunk unavailable"); });

it.each(["Close", "Escape"])("keeps chats open and restores focus when a failed dialog load is dismissed with %s", async dismissal => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const container = document.createElement("div"); document.body.append(container);
	const root = createRoot(container);
	const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
	let result: Promise<boolean> | undefined;
	const frame = async () => { const { promise, resolve } = Promise.withResolvers<void>(); requestAnimationFrame(() => resolve()); await promise; };
	try {
		await act(async () => root.render(createElement(Fragment, null,
			createElement("button", { onClick: () => { result = confirmCloseAllTabs(["saved"]); } }, "Close all chats"),
			createElement("main", { id: "vo-main", tabIndex: -1 }), createElement(QuitDialog))));
		const opener = container.querySelector("button")!;
		await act(async () => { opener.focus(); opener.click(); await frame(); });
		await act(async () => { await frame(); });
		const dialog = document.querySelector('[role="dialog"]')!;
		expect(dialog.textContent).toContain("Couldn't load this part of visual-omp");
		expect(dialog.textContent).toContain("Try again");
		expect(useQuitRequest.getState().request?.kind).toBe("all");
		await act(async () => {
			if (dismissal === "Close") [...dialog.querySelectorAll("button")].find(button => button.textContent === "Close")!.click();
			else document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			await result;
		});
		await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(opener)); });
		expect(await result).toBe(false);
		expect(useQuitRequest.getState().request).toBeNull();
		expect(document.activeElement).toBe(opener);
	} finally { await act(async () => root.unmount()); container.remove(); quiet.mockRestore(); }
});
