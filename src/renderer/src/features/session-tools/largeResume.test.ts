// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResumeDeclinedError, type ResumeRequest } from "../../registry/guards";
import { toast } from "../../ui/toast";
import { answerLargeResume, askLargeResume, LargeResumeHost, useLargeResume } from "./largeResume";

const app = vi.hoisted(() => ({ newChat: vi.fn<(projectPath?: string) => Promise<string | null>>() }));
vi.mock("../../state/app", () => ({ useApp: { getState: () => ({ newChat: app.newChat }) } }));
vi.mock("../../ui/toast", () => ({ toast: vi.fn() }));

const request = (tabId: string, controller = new AbortController()): ResumeRequest => ({ tabId, projectPath: `/projects/${tabId}`, file: `/sessions/${tabId}.jsonl`, bytes: 70_531_373, signal: controller.signal });
const shown = () => useLargeResume.getState().pending?.request.tabId ?? null;
const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
	app.newChat.mockReset().mockResolvedValue("new-tab");
	vi.mocked(toast).mockClear();
	useLargeResume.setState({ pending: null });
});

describe("large-chat warning requests", () => {
	it("shows one chat's question at a time and gives each its own answer", async () => {
		const first = askLargeResume(request("a"));
		const second = askLargeResume(request("b"));
		expect(shown()).toBe("a");
		answerLargeResume("resume");
		await expect(first).resolves.toBe(true);
		expect(shown()).toBe("b");
		answerLargeResume("cancel");
		await expect(second).resolves.toBe(false);
		expect(shown()).toBeNull();
		expect(app.newChat).not.toHaveBeenCalled();
	});

	it("answers no for a chat that closes while it is shown or waiting", async () => {
		const closingShown = new AbortController();
		const closingWaiting = new AbortController();
		const shownAsk = askLargeResume(request("a", closingShown));
		const waitingAsk = askLargeResume(request("b", closingWaiting));
		const lastAsk = askLargeResume(request("c"));
		closingWaiting.abort();
		await expect(waitingAsk).resolves.toBe(false);
		closingShown.abort();
		await expect(shownAsk).resolves.toBe(false);
		expect(shown()).toBe("c");
		answerLargeResume("resume");
		await expect(lastAsk).resolves.toBe(true);
	});

	it("Start new chat declines the resume and opens a chat in the same folder", async () => {
		const asked = askLargeResume(request("a"));
		answerLargeResume("new-chat");
		await expect(asked).resolves.toBe(false);
		expect(app.newChat).toHaveBeenCalledExactlyOnceWith("/projects/a");
		expect(toast).not.toHaveBeenCalled();
	});

	it("reports a new chat that could not be opened", async () => {
		app.newChat.mockRejectedValue(new Error("folder is gone"));
		const asked = askLargeResume(request("a"));
		answerLargeResume("new-chat");
		await expect(asked).resolves.toBe(false);
		await flush();
		expect(toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tone: "err", description: "folder is gone" }));
	});

	it("answers no without showing anything for a chat that closed before its question", async () => {
		const closed = new AbortController();
		closed.abort();
		await expect(askLargeResume(request("a", closed))).resolves.toBe(false);
		expect(shown()).toBeNull();
	});

	it("keeps reporting unhandled rejections other than a declined resume", async () => {
		const asked = askLargeResume(request("a"));
		answerLargeResume("cancel");
		await asked;
		const prevented = (reason: unknown) => {
			const event = new Event("unhandledrejection", { cancelable: true });
			Object.defineProperty(event, "reason", { value: reason });
			window.dispatchEvent(event);
			return event.defaultPrevented;
		};
		expect(prevented(new ResumeDeclinedError())).toBe(true);
		expect(prevented(new Error("omp could not start"))).toBe(false);
	});
});

describe("large-chat warning dialog", () => {
	let root: Root;
	let element: HTMLDivElement;
	beforeEach(async () => {
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		element = document.createElement("div");
		document.body.append(element);
		root = createRoot(element);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		element.remove();
	});
	/** Ask and render the dialog; the answer comes back wrapped, so awaiting the render never awaits the answer. */
	const open = async (): Promise<{ answered: Promise<boolean> }> => {
		const answered = askLargeResume(request("a"));
		await act(async () => {
			root.render(createElement(LargeResumeHost));
			// The dialog loads from its own chunk; await the same module.
			await import("./LargeResumeDialog");
		});
		return { answered };
	};

	it("states the size and focuses Cancel", async () => {
		const { answered } = await open();
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("This chat's saved history is 70.5 MB.");
		expect(document.activeElement?.textContent).toBe("Cancel");
		await act(async () => answerLargeResume("cancel"));
		await expect(answered).resolves.toBe(false);
	});

	it("cancels on Escape", async () => {
		const { answered } = await open();
		await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		await expect(answered).resolves.toBe(false);
		expect(shown()).toBeNull();
		expect(app.newChat).not.toHaveBeenCalled();
	});
});
