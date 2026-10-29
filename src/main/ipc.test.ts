import { beforeEach, expect, it, vi } from "vitest";
import { setAppRendererUrl } from "./services/app-origin";

const fake = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
	BrowserWindow: { getAllWindows: () => [] },
	ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => fake.handlers.set(channel, handler) },
}));
import { handle } from "./ipc";

beforeEach(() => {
	fake.handlers.clear();
	setAppRendererUrl("file:///app/out/renderer/index.html");
});

it("invokes only for the app main frame", () => {
	const handler = vi.fn(() => undefined);
	handle("app:openExternal", handler);
	const mainFrame = { url: "file:///app/out/renderer/index.html#chat" };
	const invoke = fake.handlers.get("app:openExternal")!;
	invoke({ senderFrame: mainFrame, sender: { mainFrame } }, "https://example.com");
	expect(handler).toHaveBeenCalledWith("https://example.com");
});

it("refuses child frames, foreign documents and missing frames before calling handlers", () => {
	const handler = vi.fn(() => undefined);
	handle("app:openExternal", handler);
	const mainFrame = { url: "file:///app/out/renderer/index.html" };
	const invoke = fake.handlers.get("app:openExternal")!;
	expect(() => invoke({ senderFrame: { ...mainFrame }, sender: { mainFrame } })).toThrow("visual-omp window");
	expect(() => invoke({ senderFrame: null, sender: { mainFrame } })).toThrow("visual-omp window");
	const foreign = { url: "https://hostile.example" };
	expect(() => invoke({ senderFrame: foreign, sender: { mainFrame: foreign } })).toThrow("visual-omp window");
	expect(handler).not.toHaveBeenCalled();
});
