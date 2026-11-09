// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { commandPanelFrames } from "@shared/tsp/testing/command-panel-fixtures";
import type { SessionController, SessionView } from "../../state/session";
import { runCommand } from "./drive";
import { commandResults } from "./results";

const fake = vi.hoisted(() => ({ snapshot: null as TspHostSnapshot | null, listeners: new Set<() => void>() }));
vi.mock("../../state/tsp/hosts", () => ({ tspHost: (hostId: string) => ({ hostId, getSnapshot: () => fake.snapshot, failed: () => false, subscribe: (listener: () => void) => { fake.listeners.add(listener); return () => fake.listeners.delete(listener); } }) }));
vi.mock("@/ui", () => ({ toast: vi.fn() }));
const publish = (snapshot: TspHostSnapshot) => { fake.snapshot = snapshot; for (const listener of fake.listeners) listener(); };
function session(command: () => Promise<void>, earlierWrite?: () => void) {
	const listeners = new Set<() => void>();
	const guest = { entries: [], phase: "live", loading: false, header: { id: "room" } };
	const view = { mode: "live", working: false, host: { hostId: "host", sessionId: "room", generation: 1, transport: "tsp" }, guest, displayLeaf: null, history: null } as unknown as SessionView;
	return { hostId: "host", getSnapshot: () => view, guestClient: () => guest, whenLive: async () => {}, holdQueue: () => {}, command: async (_line: string, beforeSubmit?: () => void) => { earlierWrite?.(); beforeSubmit?.(); await command(); },
		subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, onEvent: () => () => {}, tspNotices: { beginCommand: vi.fn() } } as unknown as SessionController;
}
beforeEach(() => { vi.useFakeTimers(); fake.listeners.clear(); });
afterEach(() => { vi.useRealTimers(); fake.listeners.clear(); });
it("collects bare native cleanse through its question without a second toast outcome", async () => {
	const frames = commandPanelFrames("cleanse"); fake.snapshot = frames[0]!;
	const chat = session(async () => { publish(frames.at(-2)!); }); const present = vi.fn(() => false);
	const pending = runCommand(chat, "/cleanse", { present });
	await vi.advanceTimersByTimeAsync(10);
	publish(frames.at(-1)!); await vi.advanceTimersByTimeAsync(650);
	expect(await pending).toEqual({ output: [], screen: [] });
	expect(chat.tspNotices.beginCommand).not.toHaveBeenCalled();
	expect(commandResults(chat)).toMatchObject([{ command: "/cleanse", tone: "warn", lines: ["No runnable checker", "No supported checker with an available executable was found."] }]);
	expect(present).toHaveBeenCalledExactlyOnceWith({ output: [], screen: [] });
});
it("stops native report collection when its submission rejects", async () => {
	const frames = commandPanelFrames("advisor-status"); fake.snapshot = frames[0]!;
	const chat = session(async () => { throw new Error("Submission refused"); });
	await expect(runCommand(chat, "/advisor status")).rejects.toThrow("Submission refused");
	publish(frames.at(-1)!);
	expect(commandResults(chat)).toEqual([]); expect(fake.listeners.size).toBe(0);
});

it("excludes a report published by an earlier serialized write before this command submits", async () => {
	const frames = commandPanelFrames("advisor-status"); fake.snapshot = frames[0]!;
	const chat = session(async () => {}, () => { publish(frames.at(-1)!); publish(frames[0]!); });
	const pending = runCommand(chat, "/advisor status");
	await vi.advanceTimersByTimeAsync(650);
	expect(await pending).toEqual({ output: [], screen: [] });
	expect(commandResults(chat)).toEqual([]);
});
