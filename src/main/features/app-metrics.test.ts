import { beforeEach, expect, it, vi } from "vitest";
import { setAppRendererUrl } from "../services/app-origin";

const fake = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(), metrics: vi.fn(), visible: true, minimized: false }));
vi.mock("electron", () => ({
	app: { getAppMetrics: fake.metrics },
	BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, isVisible: () => fake.visible, isMinimized: () => fake.minimized }] },
	ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => fake.handlers.set(channel, handler) },
}));
import { register } from "./app-metrics";
const frame = { url: "file:///app/out/renderer/index.html" };
const event = { senderFrame: frame, sender: { mainFrame: frame } };
const invoke = (reset = false) => fake.handlers.get("app:metrics")!(event, reset);
beforeEach(() => {
	setAppRendererUrl(frame.url);
	fake.visible = true;
	fake.minimized = false;
	fake.metrics.mockReset().mockReturnValue([{ pid: 1, creationTime: 1, cpu: { cumulativeCPUUsage: 1 }, memory: { workingSetSize: 100 } }]);
	register();
});
it("returns only aggregates from the native boundary on demand", () => {
	expect(fake.metrics).not.toHaveBeenCalled();
	expect(invoke(true)).toEqual({ cpuPercent: null, memoryBytes: 102400 });
	expect(fake.metrics).toHaveBeenCalledOnce();
});
it.each(["hidden", "minimized"])("does not sample while %s", state => {
	if (state === "hidden") fake.visible = false;
	else fake.minimized = true;
	expect(invoke()).toEqual({ cpuPercent: null, memoryBytes: null });
	expect(fake.metrics).not.toHaveBeenCalled();
	fake.visible = true;
	fake.minimized = false;
	expect(invoke()).toEqual({ cpuPercent: null, memoryBytes: 102400 });
});
it("validates the sender and reset argument before accessing metrics", () => {
	const handler = fake.handlers.get("app:metrics")!;
	expect(() => handler({ senderFrame: { ...frame }, sender: { mainFrame: frame } }, false)).toThrow("visual-omp window");
	expect(() => handler(event, "false")).toThrow("Invalid app metrics request");
	expect(fake.metrics).not.toHaveBeenCalled();
});
