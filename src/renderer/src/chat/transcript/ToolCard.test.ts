// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppPreferences } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRefContext } from "./fileRefScope";
import { ToolCard, type ToolCardProps } from "./ToolCard";
import { useApp } from "../../state/app";
import { useLivePreview } from "../../features/live-preview/store";
import { TooltipProvider } from "../../ui";
import "../../i18n";

vi.hoisted(() => {
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin" } });
});

let element: HTMLDivElement, root: Root;
const showPane = vi.fn();
const previousState = useApp.getState();
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	useApp.setState({ prefs: { livePreview: true } as AppPreferences, showPane });
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	element.remove();
	useLivePreview.getState().forget("watch-chat");
	useApp.setState(previousState);
	showPane.mockClear();
});

async function render(running: boolean) {
	await act(async () => root.render(createElement(TooltipProvider, null,
		createElement(FileRefContext.Provider, { value: { chat: "watch-chat", bases: [] } },
			createElement(ToolCard, { name: "eval", args: { language: "js", code: "console.log(1)" }, running, verbose: false, engageId: "visual-call" })))));
	await vi.waitFor(async () => {
		await act(async () => {});
		expect(element.querySelector("[data-live-watch]")).not.toBeNull();
	});
}

describe("tool card Watch control", () => {
	it.each([true, false])("keeps Watch after the disclosure in keyboard order and opens only the preview (running: %s)", async running => {
		await render(running);
		const buttons = [...element.querySelectorAll<HTMLButtonElement>("button")];
		expect(buttons).toHaveLength(2);
		const [toggle, watch] = buttons as [HTMLButtonElement, HTMLButtonElement];
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(watch.getAttribute("aria-label")).toBe("Watch");
		expect(toggle.tabIndex).toBe(0);
		expect(watch.tabIndex).toBe(0);
		expect(toggle.contains(watch)).toBe(false);
		await act(async () => watch.click());
		expect(showPane).toHaveBeenCalledWith("outputs", "watch-chat");
		expect(useLivePreview.getState().chats["watch-chat"]?.selected).toBe("call:visual-call");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});
});

async function renderStatus(props: Partial<ToolCardProps> = {}) {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(ToolCard, {
		name: "bash", args: { command: "npm test" }, running: false, verbose: false, ...props,
	}))));
}

function status(): string | null {
	return element.querySelector("[data-tool-status]")?.getAttribute("data-tool-status") ?? null;
}

describe("tool card result status", () => {
	it("shows the existing neutral mark for a settled omitted result", async () => {
		await renderStatus();
		expect(status()).toBe("neutral");
		expect(element.querySelector('[role="img"][aria-label="Result unavailable"]')).not.toBeNull();
		expect(element.textContent).toContain("bash result unavailable");
	});

	it.each([false, true])("updates an omitted call from its recovered result (error: %s)", async isError => {
		await renderStatus();
		expect(status()).toBe("neutral");
		await renderStatus({ result: { content: [{ type: "text", text: "recovered output" }], isError } });
		expect(status()).toBe(isError ? "error" : "ok");
		expect(element.textContent).not.toContain("result unavailable");
	});

	it.each([
		undefined,
		{ content: [], isError: false },
		{ content: [], isError: true },
	])("keeps running precedence over an absent or partial result", async result => {
		await renderStatus({ running: true, result });
		expect(status()).toBe("running");
		expect(element.textContent).toContain("Running npm test");
	});

	it.each([false, true])("keeps ordinary result status (error: %s)", async isError => {
		await renderStatus({ result: { content: [], isError } });
		expect(status()).toBe(isError ? "error" : "ok");
	});

	it("does not let a custom success summary claim success without a result", async () => {
		await renderStatus({ summary: { key: "bash.passed", values: { command: "npm test" }, status: "ok" } });
		expect(status()).toBe("neutral");
	});
});
