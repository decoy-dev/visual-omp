// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useComposerDrafts } from "../../chat/composer/drafts";
import type { ResumeMessage, ResumeRequest } from "../../registry/guards";
import type { SessionController } from "../../state/session";
import { cancelLargeHandoff, LargeHandoffRow, retryLargeHandoff, sendWithoutHandoff, startLargeHandoff, useLargeHandoffs } from "./largeHandoff";

const app = vi.hoisted(() => ({
	state: { tabs: [] as { id: string; title: string }[], newChat: vi.fn<(folder: string) => Promise<string | null>>() },
	listeners: new Set<(state: { tabs: { id: string; title: string }[] }) => void>(),
	controllers: new Map<string, unknown>(),
}));
vi.mock("../../state/app", () => ({
	useApp: { getState: () => app.state, subscribe: (listener: (state: { tabs: { id: string; title: string }[] }) => void) => { app.listeners.add(listener); return () => app.listeners.delete(listener); } },
	controllerFor: (id: string) => app.controllers.get(id),
}));
vi.mock("../../shell/hooks", () => ({ chatTitle: (_view: unknown, title: string) => title, elapsed: () => "0:00", useNow: () => Date.now() }));

const images = [{ path: "/projects/design/first image.png", name: "first image.png" }, { path: "/projects/design/second.png", name: "second.png" }];
const file = "/projects/design/handoff notes/context.md";
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const request = (message?: ResumeMessage, signal = new AbortController().signal): ResumeRequest => ({ tabId: "source", projectPath: "/projects/design", file: "/sessions/source.jsonl", bytes: 70_531_373, signal, ...(message ? { message } : {}) });
const close = (id: string) => { app.state.tabs = app.state.tabs.filter(tab => tab.id !== id); for (const listener of [...app.listeners]) listener(app.state); };
const drafts = () => useComposerDrafts.getState();
const entry = () => useLargeHandoffs.getState().pending.destination;
let result: PromiseWithResolvers<{ file: string }>;
let invoke: Mock;
let send: Mock;
let release: Mock;
let holdQueue: Mock;
let root: Root;
let element: HTMLDivElement;
const controller = () => app.controllers.get("destination") as SessionController;
const renderRow = async () => { await act(async () => root.render(createElement(LargeHandoffRow, { session: controller() }))); };
const click = async (label: string) => {
	const button = [...element.querySelectorAll("button")].find(item => item.textContent === label);
	expect(button, `Missing ${label} action`).toBeDefined();
	await act(async () => { button!.click(); await flush(); });
};
const assertDraft = (text = "Continue this work", attachments = images) => {
	expect(drafts().drafts.destination).toBe(text);
	expect(drafts().attachments.destination).toEqual(attachments);
	expect(drafts().sendBlocks.destination).toBe(true);
};

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	result = Promise.withResolvers<{ file: string }>();
	invoke = vi.fn((channel: string) => channel === "sessions:handoff" ? result.promise : Promise.resolve());
	Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
	send = vi.fn().mockResolvedValue({ kind: "submitted" });
	release = vi.fn();
	holdQueue = vi.fn((until: Promise<unknown>) => { void until.then(release); });
	app.controllers.clear();
	app.controllers.set("source", { getSnapshot: () => null });
	app.controllers.set("destination", { tabId: "destination", sendWithOwnership: send, holdQueue });
	app.state.tabs = [{ id: "source", title: "Large design chat" }];
	app.state.newChat.mockReset().mockImplementation(async () => { app.state.tabs.push({ id: "destination", title: "New chat" }); return "destination"; });
	useComposerDrafts.setState({ drafts: {}, attachments: {}, previews: {}, modes: {}, sendBlocks: {}, pendingFocus: {}, editorRestores: {} });
	drafts().setDraft("source", "Continue this work");
	drafts().addAttachments("source", images);
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
});
afterEach(async () => {
	await act(async () => { close("destination"); result.resolve({ file }); await flush(); root.unmount(); });
	element.remove();
	app.listeners.clear();
	useLargeHandoffs.setState({ pending: {} });
});

describe("large-chat handoff transfer", () => {
	it("moves the real text and attachments once, holds the queue and blocks ordinary submission", async () => {
		await startLargeHandoff(request());
		expect(app.state.newChat).toHaveBeenCalledExactlyOnceWith("/projects/design");
		assertDraft();
		expect(drafts().drafts.source).toBe("");
		expect(drafts().attachments.source).toEqual([]);
		expect(drafts().pendingFocus.destination).toBe(true);
		expect(holdQueue).toHaveBeenCalledTimes(1);
		expect(release).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(invoke).toHaveBeenCalledExactlyOnceWith("sessions:handoff", expect.any(String), "/sessions/source.jsonl", "/projects/design", "Prepare for this next request:\nContinue this work\nAttached images: /projects/design/first image.png, /projects/design/second.png");
	});

	it.each([{ kind: "submitted" }, { kind: "queued", id: "q1" }])("sends exactly one quoted file mention with message and images and clears duplicate draft for $kind ownership", async receipt => {
		send.mockResolvedValue(receipt);
		await startLargeHandoff(request());
		result.resolve({ file }); result.resolve({ file });
		await flush();
		expect(send).toHaveBeenCalledExactlyOnceWith('@"/projects/design/handoff notes/context.md"\n\nContinue this work', images);
		expect(release).toHaveBeenCalledTimes(1);
		expect(drafts().drafts.destination).toBe("");
		expect(drafts().attachments.destination).toEqual([]);
		expect(drafts().sendBlocks.destination).toBeUndefined();
		expect(entry()).toBeUndefined();
		await cancelLargeHandoff("destination"); retryLargeHandoff("destination"); await sendWithoutHandoff("destination");
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("uses the submitted message instead of an unrelated edited source draft and marks it consumed", async () => {
		const submitted = { text: "The submitted request", images: [images[0]!] };
		const original = request(submitted);
		await startLargeHandoff(original);
		expect(original.messageTransferred).toBe(true);
		assertDraft(submitted.text, submitted.images);
		expect(drafts().drafts.source).toBe("Continue this work");
		expect(drafts().attachments.source).toEqual(images);
		result.resolve({ file }); await flush();
		expect(send).toHaveBeenCalledExactlyOnceWith('@"/projects/design/handoff notes/context.md"\n\nThe submitted request', submitted.images);
	});

	it("moves a recalled draft with its quick mode applied and clears source mode", async () => {
		drafts().setPreview("source", "print('hello')"); drafts().setMode("source", "python");
		drafts().setPreview("source", "print('hello')");
		await startLargeHandoff(request());
		assertDraft("$ print('hello')");
		expect(drafts().modes.source).toBeNull();
	});

	it("sends an image-only message and handoff without inventing message text", async () => {
		await startLargeHandoff(request({ text: "", images }));
		result.resolve({ file }); await flush();
		expect(send).toHaveBeenCalledExactlyOnceWith('@"/projects/design/handoff notes/context.md"', images);
	});

	it("continues when the source closes after transfer", async () => {
		const abort = new AbortController();
		await startLargeHandoff(request(undefined, abort.signal));
		close("source"); abort.abort(); result.resolve({ file }); await flush();
		expect(send).toHaveBeenCalledTimes(1);
		expect(invoke.mock.calls.filter(([channel]) => channel === "sessions:cancelHandoff")).toEqual([]);
	});

	it("cancels RPC work and ignores late completion when the destination closes", async () => {
		await startLargeHandoff(request());
		const id = invoke.mock.calls[0]![1];
		close("destination"); result.resolve({ file }); await flush();
		expect(invoke).toHaveBeenCalledWith("sessions:cancelHandoff", id);
		expect(send).not.toHaveBeenCalled();
		expect(entry()).toBeUndefined();
		expect(drafts().sendBlocks.destination).toBeUndefined();
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("does nothing when the source was already closed", async () => {
		const abort = new AbortController(); abort.abort();
		await startLargeHandoff(request(undefined, abort.signal));
		expect(app.state.newChat).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalled();
		expect(drafts().drafts.source).toBe("Continue this work");
	});

	it("keeps submitted input owned by the source when no destination opens", async () => {
		app.state.newChat.mockResolvedValue(null);
		const original = request({ text: "Continue this work", images });
		await startLargeHandoff(original);
		expect(original.messageTransferred).toBeUndefined();
		expect(drafts().drafts.source).toBe("Continue this work");
		expect(drafts().attachments.source).toEqual(images);
		expect(invoke).not.toHaveBeenCalled();
		expect(holdQueue).not.toHaveBeenCalled();
	});

	it("sends only the handoff when there is no text or image to transfer", async () => {
		drafts().setDraft("source", ""); drafts().clearAttachments("source");
		await startLargeHandoff(request());
		expect(invoke.mock.calls[0]![4]).toBe("");
		result.resolve({ file }); await flush();
		expect(send).toHaveBeenCalledExactlyOnceWith('@"/projects/design/handoff notes/context.md"', []);
	});
});

describe("large-chat handoff recovery", () => {
	it.each(["The handoff could not be written.", "The handoff timed out after 120 seconds."])("preserves the draft and exposes explicit actions for %s", async error => {
		await startLargeHandoff(request()); await renderRow();
		expect(element.textContent).toContain("Writing a handoff");
		expect(element.textContent).toContain("Cancel");
		await act(async () => { result.reject(new Error(error)); await flush(); });
		assertDraft();
		expect(element.textContent).toContain(error);
		expect(entry()?.phase).toBe("failed");
		expect(element.querySelector('[role="status"]')?.textContent).toBe("The handoff could not be completed.");
		expect(element.querySelector(".text-warn")).not.toBeNull();
		expect([...element.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Send without handoff", "Try again"]);
		expect(send).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
	});

	it("cancels once, preserves input and ignores completion racing with cancellation", async () => {
		const cancellation = Promise.withResolvers<void>();
		invoke.mockImplementation((channel: string) => channel === "sessions:handoff" ? result.promise : cancellation.promise);
		await startLargeHandoff(request()); await renderRow();
		await click("Cancel");
		await cancelLargeHandoff("destination");
		await act(async () => { result.resolve({ file }); await flush(); });
		expect(send).not.toHaveBeenCalled();
		await act(async () => { cancellation.resolve(); await flush(); });
		assertDraft();
		expect(entry()?.phase).toBe("cancelled");
		expect(entry()?.error).toBeUndefined();
		expect(element.querySelector('[role="status"]')?.textContent).toBe("The handoff was cancelled.");
		expect(element.querySelector("p")?.textContent).toBe("Your message is still a draft.");
		expect(element.textContent).not.toContain("could not be completed");
		expect(element.querySelector(".text-warn")).toBeNull();
		expect(element.querySelector("svg.text-fg-muted")).not.toBeNull();
		expect(element.textContent).toContain("Send without handoff");
		expect(element.textContent).toContain("Try again");
		expect(invoke.mock.calls.filter(([channel]) => channel === "sessions:cancelHandoff")).toHaveLength(1);
		expect(send).not.toHaveBeenCalled();
	});

	it("preserves draft and explicit actions when cancellation itself fails", async () => {
		await startLargeHandoff(request());
		invoke.mockRejectedValue(new Error("Cancellation was refused"));
		await cancelLargeHandoff("destination"); await renderRow();
		assertDraft();
		expect(element.textContent).toContain("Cancellation was refused");
		expect(entry()?.phase).toBe("failed");
		expect(element.querySelector('[role="status"]')?.textContent).toBe("The handoff could not be completed.");
		expect(element.querySelector(".text-warn")).not.toBeNull();
		expect(element.textContent).toContain("Send without handoff");
		expect(element.textContent).toContain("Try again");
		result.resolve({ file }); await flush();
		expect(send).not.toHaveBeenCalled();
	});

	it.each(["failed", "cancelled"] as const)("Send without handoff sends only the retained message once after %s", async phase => {
		await startLargeHandoff(request());
		if (phase === "cancelled") await cancelLargeHandoff("destination");
		else { result.reject(new Error("Timed out")); await flush(); }
		await renderRow();
		const sending = Promise.withResolvers<{ kind: "submitted" }>(); send.mockReturnValue(sending.promise);
		await click("Send without handoff");
		await sendWithoutHandoff("destination");
		expect(send).toHaveBeenCalledExactlyOnceWith("Continue this work", images);
		expect(entry()?.phase).toBe("sending");
		await act(async () => { sending.resolve({ kind: "submitted" }); await flush(); });
		expect(entry()).toBeUndefined();
	});

	it("Try again starts one new RPC and discards the cancelled RPC's late result", async () => {
		await startLargeHandoff(request()); await cancelLargeHandoff("destination"); await renderRow();
		const retry = Promise.withResolvers<{ file: string }>();
		invoke.mockImplementation((channel: string) => channel === "sessions:handoff" ? retry.promise : Promise.resolve());
		await click("Try again"); retryLargeHandoff("destination");
		const calls = invoke.mock.calls.filter(([channel]) => channel === "sessions:handoff");
		expect(calls).toHaveLength(2);
		expect(calls[1]![1]).not.toBe(calls[0]![1]);
		assertDraft();
		result.resolve({ file: "/stale.md" }); await flush();
		expect(send).not.toHaveBeenCalled();
		await act(async () => { retry.resolve({ file }); await flush(); });
		expect(send).toHaveBeenCalledExactlyOnceWith('@"/projects/design/handoff notes/context.md"\n\nContinue this work', images);
	});

	it("retains the old operation id through repeated cleanup failures before starting one retry", async () => {
		await startLargeHandoff(request());
		const originalId = invoke.mock.calls.find(([channel]) => channel === "sessions:handoff")![1];
		result.reject(new Error("Process termination could not be confirmed."));
		await flush();
		const cleanup = Promise.withResolvers<void>();
		const next = Promise.withResolvers<{ file: string }>();
		let cleanups = 0;
		invoke.mockImplementation((channel: string) => {
			if (channel === "sessions:handoff") return next.promise;
			if (++cleanups <= 2) return Promise.reject(new Error("The old process is still running."));
			return cleanup.promise;
		});
		await retryLargeHandoff("destination");
		await retryLargeHandoff("destination");
		assertDraft();
		expect(entry()?.error).toBe("The old process is still running.");
		expect(invoke.mock.calls.filter(([channel]) => channel === "sessions:handoff")).toHaveLength(1);
		const retrying = retryLargeHandoff("destination");
		await retryLargeHandoff("destination");
		expect(entry()?.phase).toBe("stopping");
		expect(invoke.mock.calls.filter(([channel]) => channel === "sessions:cancelHandoff").map(call => call[1])).toEqual([originalId, originalId, originalId]);
		cleanup.resolve();
		await flush();
		const calls = invoke.mock.calls.filter(([channel]) => channel === "sessions:handoff");
		expect(calls).toHaveLength(2);
		expect(calls[1]![1]).not.toBe(originalId);
		next.resolve({ file });
		await retrying;
		expect(send).toHaveBeenCalledExactlyOnceWith('@"/projects/design/handoff notes/context.md"\n\nContinue this work', images);
	});

	it.each(["text", "images"] as const)("does not automatically send when the destination %s changes", async kind => {
		await startLargeHandoff(request());
		if (kind === "text") drafts().setDraft("destination", "My revised request");
		else drafts().removeAttachment("destination", images[0]!.path);
		result.resolve({ file }); await flush(); await renderRow();
		expect(send).not.toHaveBeenCalled();
		assertDraft(kind === "text" ? "My revised request" : "Continue this work", kind === "images" ? [images[1]!] : images);
		expect(entry()?.phase).toBe("failed");
		expect(element.textContent).toContain("changed");
		expect(element.textContent).toContain("Send without handoff");
	});

	it("Try again uses an edited draft only after the person explicitly requests it", async () => {
		await startLargeHandoff(request());
		drafts().setDraft("destination", "My revised request");
		result.resolve({ file }); await flush(); await renderRow();
		expect(send).not.toHaveBeenCalled();
		const retry = Promise.withResolvers<{ file: string }>();
		invoke.mockImplementation((channel: string) => channel === "sessions:handoff" ? retry.promise : Promise.resolve());
		await click("Try again");
		expect(invoke.mock.calls.filter(([channel]) => channel === "sessions:handoff")[1]![4]).toContain("My revised request");
		retry.resolve({ file }); await flush();
		expect(send).toHaveBeenCalledExactlyOnceWith('@"/projects/design/handoff notes/context.md"\n\nMy revised request', images);
	});

	it("preserves edits made while the automatic send is pending", async () => {
		const sending = Promise.withResolvers<{ kind: "submitted" }>(); send.mockReturnValue(sending.promise);
		await startLargeHandoff(request()); result.resolve({ file }); await flush();
		drafts().setDraft("destination", "The next request");
		sending.resolve({ kind: "submitted" }); await flush();
		expect(drafts().drafts.destination).toBe("The next request");
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("retains the draft and recovery actions when sending fails", async () => {
		send.mockRejectedValue(new Error("omp could not start"));
		await startLargeHandoff(request()); result.resolve({ file }); await flush(); await renderRow();
		assertDraft();
		expect(element.textContent).toContain("omp could not start");
		expect(element.textContent).toContain("Send without handoff");
		expect(element.textContent).toContain("Try again");
	});
});
