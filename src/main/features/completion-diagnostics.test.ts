import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompactCompletionDiagnostic } from "@shared/completion-diagnostics";
import { setAppRendererUrl } from "../services/app-origin";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
	write: vi.fn(),
}));
vi.mock("electron", () => ({
	BrowserWindow: {},
	ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => fake.handlers.set(channel, handler) },
}));
vi.mock("../services/diagnostics/events", () => ({ writeDiagnostic: fake.write }));
import { register } from "./completion-diagnostics";

const frame = { url: "file:///app/out/renderer/index.html" };
const event = { senderFrame: frame, sender: { mainFrame: frame } };
const diagnostic: CompactCompletionDiagnostic = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 123.5, 0, 0, 2, 86, 900.5, 0, 3];
const invoke = (payload: unknown) => fake.handlers.get("app:completionDiagnostic")!(event, payload);
beforeEach(() => {
	setAppRendererUrl(frame.url);
	fake.write.mockReset();
	vi.spyOn(performance, "now").mockReturnValue(0);
	vi.spyOn(Date, "now").mockReturnValue(1000);
	register();
});
afterEach(() => vi.restoreAllMocks());

it("passes one expanded privacy-projected event through the existing writer", () => {
	expect(invoke(Object.assign([...diagnostic], { token: "secret", text: "private", event: "main-exception" }))).toBeUndefined();
	expect(fake.write).toHaveBeenCalledOnce();
	expect(fake.write).toHaveBeenCalledWith({
		event: "chat-completion", chatId: diagnostic[0], edgeId: expect.any(String), cause: "agent_end", phase: "live",
		isTerminal: true, willContinue: false, awaitingAsyncWork: false, isStreaming: false,
		sinceStreamingMs: 99, runningHelpers: 0, finished: "emitted", notificationRequested: true, suppressedReason: null,
	});
});
it("silently discards malformed payloads before the writer sees them", () => {
	for (const payload of [null, {}, "private", [...diagnostic, "private"], [diagnostic[0], 123.5, 0, 5, 2, 86, null, 0, 3]]) {
		expect(invoke(payload)).toBeUndefined();
	}
	expect(fake.write).not.toHaveBeenCalled();
});
it("retains dedup across main frame replacement and accepts a new epoch", () => {
	invoke(diagnostic);
	const reloadedFrame = { url: frame.url };
	const sender = event.sender;
	const originalFrame = sender.mainFrame;
	try {
		sender.mainFrame = reloadedFrame;
		const handler = fake.handlers.get("app:completionDiagnostic")!;
		handler({ senderFrame: reloadedFrame, sender }, diagnostic);
		expect(fake.write).toHaveBeenCalledOnce();
		const reloaded = [...diagnostic];
		reloaded[1] = 124.5;
		handler({ senderFrame: reloadedFrame, sender }, reloaded);
	} finally { sender.mainFrame = originalFrame; }
	expect(fake.write).toHaveBeenCalledTimes(2);
});
it("limits accepted lines to 30 across all invoking renderers", () => {
	for (let index = 0; index < 40; index++) {
		const payload = [...diagnostic];
		payload[2] = index;
		fake.handlers.get("app:completionDiagnostic")!({ senderFrame: frame, sender: { mainFrame: frame } }, payload);
	}
	expect(fake.write).toHaveBeenCalledTimes(30);
});
it("uses the standard top-level app-origin boundary", () => {
	const handler = fake.handlers.get("app:completionDiagnostic")!;
	expect(() => handler({ senderFrame: { ...frame }, sender: event.sender }, diagnostic)).toThrow("visual-omp window");
	const remoteFrame = { url: "https://untrusted.example/" };
	expect(() => handler({ senderFrame: remoteFrame, sender: { mainFrame: remoteFrame } }, diagnostic)).toThrow("visual-omp window");
	expect(fake.write).not.toHaveBeenCalled();
});
