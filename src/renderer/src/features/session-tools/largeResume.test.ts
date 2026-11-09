// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { ResumeDeclinedError, type ResumeRequest } from "../../registry/guards";
import { toast } from "../../ui/toast";
import { answerLargeResume, askLargeResume, LargeResumeHost, useLargeResume } from "./largeResume";

const app = vi.hoisted(() => ({ newChat: vi.fn<(projectPath?: string) => Promise<string | null>>() }));
vi.mock("../../state/app", () => ({ useApp: { getState: () => ({ newChat: app.newChat }) } }));
const handoff = vi.hoisted(() => ({ start: vi.fn<(request: ResumeRequest) => Promise<void>>() }));
vi.mock("./largeHandoff", () => ({ startLargeHandoff: handoff.start }));
vi.mock("../../ui/toast", () => ({ toast: vi.fn() }));

const request = (tabId: string, controller = new AbortController()): ResumeRequest => ({ tabId, projectPath: `/projects/${tabId}`, file: `/sessions/${tabId}.jsonl`, bytes: 70_531_373, signal: controller.signal });
const shown = () => useLargeResume.getState().pending?.request.tabId ?? null;
const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
	app.newChat.mockReset().mockResolvedValue("new-tab");
	handoff.start.mockReset().mockResolvedValue(undefined);
	vi.mocked(toast).mockClear();
	useLargeResume.setState({ pending: null });
	useComposerDrafts.setState({ drafts: {}, attachments: {}, previews: {}, modes: {}, sendBlocks: {}, pendingFocus: {} });
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

	it("Start new chat brings a handoff by default and declines the old resume", async () => {
		const original = request("a");
		const asked = askLargeResume(original);
		answerLargeResume("new-chat");
		await expect(asked).resolves.toBe(false);
		expect(handoff.start).toHaveBeenCalledExactlyOnceWith(original);
		expect(app.newChat).not.toHaveBeenCalled();
		expect(toast).not.toHaveBeenCalled();
	});

	it("opens an empty chat in the same folder when handoff is unchecked", async () => {
		const asked = askLargeResume(request("a"));
		answerLargeResume("new-chat", false);
		await expect(asked).resolves.toBe(false);
		expect(app.newChat).toHaveBeenCalledExactlyOnceWith("/projects/a");
		expect(handoff.start).not.toHaveBeenCalled();
	});

	it("reports a new chat that could not be opened", async () => {
		app.newChat.mockRejectedValue(new Error("folder is gone"));
		const asked = askLargeResume(request("a"));
		answerLargeResume("new-chat", false);
		await expect(asked).resolves.toBe(false);
		await flush();
		expect(toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tone: "err", description: "folder is gone" }));
	});

	it("reports a handoff transfer that could not open its destination", async () => {
		handoff.start.mockRejectedValue(new Error("The destination could not open"));
		const asked = askLargeResume(request("a"));
		answerLargeResume("new-chat");
		await expect(asked).resolves.toBe(false);
		expect(toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tone: "err", description: "The destination could not open" }));
		expect(app.newChat).not.toHaveBeenCalled();
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
	const open = async (message?: ResumeRequest["message"]): Promise<{ answered: Promise<boolean> }> => {
		const answered = askLargeResume({ ...request("a"), ...(message ? { message } : {}) });
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

	it.each([
		{ message: undefined, label: "Bring a handoff to the new chat" },
		{ message: { text: "Continue with this request", images: [] }, label: "Bring a handoff and my message to the new chat" },
		{ message: { text: "", images: [{ path: "/image.png", name: "image.png" }] }, label: "Bring a handoff and my message to the new chat" },
		{ message: { text: "   ", images: [] }, label: "Bring a handoff to the new chat" },
	])("checks the handoff by default with wording $label", async ({ message, label }) => {
		const { answered } = await open(message);
		const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		expect(checkbox.checked).toBe(true);
		expect([...document.querySelectorAll("label")].find(item => item.htmlFor === checkbox.id && item.textContent)?.textContent).toContain(label);
		const dialog = document.querySelector('[role="dialog"]')!;
		expect(dialog.textContent).toContain("omp writes a handoff from this conversation");
		if (!message || (!message.text.trim() && !message.images.length)) expect(dialog.textContent).not.toContain("pending message");
		await act(async () => answerLargeResume("cancel"));
		await expect(answered).resolves.toBe(false);
	});

	it.each(["text", "image"])("uses pending composer %s for checkbox wording when no submitted message exists", async kind => {
		const drafts = useComposerDrafts.getState();
		if (kind === "text") drafts.setDraft("a", "Unsent request");
		else drafts.addAttachments("a", [{ path: "/pending.png", name: "pending.png" }]);
		const { answered } = await open();
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Bring a handoff and my message to the new chat");
		await act(async () => answerLargeResume("cancel"));
		await expect(answered).resolves.toBe(false);
	});

	it("unchecking explains the empty chat and Start new chat skips the handoff", async () => {
		const { answered } = await open({ text: "Keep my message here", images: [] });
		await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("without this conversation's history");
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("stays unsent in this chat");
		await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Start new chat")!.click());
		await expect(answered).resolves.toBe(false);
		expect(app.newChat).toHaveBeenCalledExactlyOnceWith("/projects/a");
		expect(handoff.start).not.toHaveBeenCalled();
	});

	it("checked Start new chat transfers the exact message request", async () => {
		const message = { text: "My next request", images: [{ path: "/only.png", name: "only.png" }] };
		const { answered } = await open(message);
		await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Start new chat")!.click());
		await expect(answered).resolves.toBe(false);
		expect(handoff.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tabId: "a", message }));
		expect(handoff.start.mock.calls[0]![0].message).toBe(message);
		expect(app.newChat).not.toHaveBeenCalled();
	});

	it.each(["Resume chat", "Cancel"])("%s keeps its original behavior when handoff is checked", async label => {
		const { answered } = await open({ text: "Pending request", images: [] });
		await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === label)!.click());
		await expect(answered).resolves.toBe(label === "Resume chat");
		expect(handoff.start).not.toHaveBeenCalled();
		expect(app.newChat).not.toHaveBeenCalled();
	});

	it("cancels on Escape", async () => {
		const { answered } = await open();
		await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		await expect(answered).resolves.toBe(false);
		expect(shown()).toBeNull();
		expect(app.newChat).not.toHaveBeenCalled();
	});
});
