import type { ModelInfo } from "@shared/contracts/config";
import type { WireModel } from "@oh-my-pi/pi-wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController } from "../../state/session";
import { switchModel } from "./model";

// vi.hoisted runs before the imports: model.ts subscribes to `window.vomp` when it loads.
const vomp = vi.hoisted(() => {
	const vomp = {
		screen: [] as string[],
		on: () => () => undefined,
		invoke: async (channel: string) => (channel === "host:screen" ? vomp.screen : null),
	};
	vi.stubGlobal("window", { vomp });
	return vomp;
});
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/ui", () => ({ toast }));

const statusLine = (name: string) => `╭── π ▶ ⬢ ${name} · ◕ high ▶ proj ──╮`;
const haiku: WireModel = { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000 };
const sonnet: ModelInfo = {
	selector: "anthropic/claude-sonnet-4-5",
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	kind: "chat",
	contextWindow: 200_000,
	maxOutputTokens: 64_000,
	reasoning: true,
	thinkingLevels: ["low", "medium", "high"],
	vision: true,
	cost: null,
};
const sonnetState: WireModel = { provider: sonnet.provider, id: sonnet.id, name: sonnet.name, contextWindow: sonnet.contextWindow };

/** omp's state as its collab stream reports it, and what omp does with a typed command. */
let current: WireModel;
let tokens: number;
let omp: (line: string) => void;
const commands: string[] = [];
const listeners = new Set<() => void>();
/** omp's collab stream reports a new model. */
function report(model: WireModel): void {
	current = model;
	for (const listener of listeners) listener();
}
// Only the members switchModel reads: a live chat with no omp dialog open.
const chat = {
	hostId: "h1",
	whenLive: async () => undefined,
	command: async (line: string) => {
		commands.push(line);
		omp(line);
	},
	subscribe: (listener: () => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	getSnapshot: () => ({ host: { tui: { overlays: 0 } }, guest: { state: { model: current, contextUsage: { tokens } } } }),
} as unknown as SessionController;

beforeEach(() => {
	vi.useFakeTimers();
	toast.mockClear();
	commands.length = 0;
	listeners.clear();
	current = haiku;
	tokens = 30_000;
	vomp.screen = [statusLine("Haiku 4.5")];
	omp = () => undefined;
});

afterEach(() => {
	vi.useRealTimers();
});

/** Run a switch to Sonnet while omp's timers play out, then report what it resolved. */
async function switchToSonnet(): Promise<boolean> {
	const result = switchModel(chat, sonnet);
	await vi.advanceTimersByTimeAsync(10_000);
	return result;
}

describe("switchModel", () => {
	it("confirms from omp's state while older transcript lines mention errors", async () => {
		// omp rewrites the previous "Session-only model" status in place, so only older lines stay put.
		vomp.screen = [" The build failed with an error.", " Session-only model: anthropic/claude-haiku-4-5.", statusLine("Haiku 4.5")];
		omp = () => {
			vomp.screen = [" The build failed with an error.", " Session-only model: anthropic/claude-sonnet-4-5.", statusLine("Sonnet 4.5")];
			report(sonnetState);
		};
		await expect(switchToSonnet()).resolves.toBe(true);
		expect(commands).toEqual(["/switch anthropic/claude-sonnet-4-5"]);
		expect(toast).not.toHaveBeenCalled();
	});

	it("waits for omp's state while a reply prints errors that name the model", async () => {
		omp = () => {
			vomp.screen = [
				" Error: request to anthropic/claude-sonnet-4-5 failed",
				" Error: No API key for anthropic/claude-sonnet-4-5",
				statusLine("Haiku 4.5"),
			];
			setTimeout(() => report(sonnetState), 1500);
		};
		await expect(switchToSonnet()).resolves.toBe(true);
		expect(toast).not.toHaveBeenCalled();
		expect(listeners.size).toBe(0);
	});

	it("warns when omp never reports the new model", async () => {
		omp = () => {
			vomp.screen = [" Error: No API key for anthropic/claude-sonnet-4-5", statusLine("Haiku 4.5")];
		};
		await expect(switchToSonnet()).resolves.toBe(false);
		expect(toast).toHaveBeenCalledWith({
			tone: "warn",
			message: "omp didn't confirm the switch to Claude Sonnet 4.5. Open the terminal sheet to see what omp shows.",
		});
		expect(listeners.size).toBe(0);
	});

	it("explains a possible compaction when the chat is longer than the model's window", async () => {
		tokens = 250_000;
		await expect(switchToSonnet()).resolves.toBe(false);
		expect(toast).toHaveBeenCalledWith({ tone: "warn", message: expect.stringContaining("omp may be compacting it first") });
	});
});
