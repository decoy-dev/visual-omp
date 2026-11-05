import type { ModelInfo } from "@shared/contracts/config";
import type { TuiFocus } from "@shared/ipc";
import type { SessionEntry, WireModel } from "@oh-my-pi/pi-wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayedEntries } from "../../chat/branch";
import type { SessionController } from "../../state/session";
import { setThinking, switchModel } from "./model";
import { configuredThinking } from "./thinking";

// vi.hoisted runs before the imports: model.ts subscribes to `window.vomp` when it loads.
const vomp = vi.hoisted(() => {
	const vomp = {
		screen: [] as string[],
		screenError: null as Error | null,
		focus: null as TuiFocus | null,
		focusError: null as Error | null,
		diagnostics: [] as (string | null)[],
		on: () => () => undefined,
		invoke: async (channel: string, _hostId: string, border: string | null) => {
			if (channel === "host:screen") {
				if (vomp.screenError) throw vomp.screenError;
				return vomp.screen;
			}
			if (channel === "host:tui-focus") {
				if (vomp.focusError) throw vomp.focusError;
				return vomp.focus;
			}
			if (channel === "host:statusUnreadable") vomp.diagnostics.push(border);
			return null;
		},
	};
	vi.stubGlobal("window", { vomp });
	return vomp;
});
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/ui", () => ({ toast }));

const boxEditor = (name: string, effort = "high") => [
	`╭── π ▶ ⬢ ${name} · ◕ ${effort} ▶ proj ──╮`,
	"╰─                          ─╯",
];
// omp 18.15.0 debug text at 80 columns, with the app's status pins and default band composer.
const bandEditor = [
	" π ▶ ⬢ Sonnet 4.6 · ◒ high ▶ 🗑 …dows-project-directory\\session-tools ▶─0.3%─┃1M─",
	"╰─                                                  ⇧⇥ to change thinking effort",
];
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
let overlays: number;
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
	getSnapshot: () => ({ host: { tui: { overlays } }, guest: { state: { model: current, contextUsage: { tokens } } } }),
} as unknown as SessionController;

beforeEach(() => {
	vi.useFakeTimers();
	toast.mockClear();
	commands.length = 0;
	listeners.clear();
	current = haiku;
	tokens = 30_000;
	overlays = 0;
	vomp.screenError = null;
	vomp.focusError = null;
	vomp.focus = { overlays: 0, focused: "editor", overlayKinds: [], altScreen: false };
	vomp.diagnostics = [];
	vomp.screen = boxEditor("Haiku 4.5");
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
		vomp.screen = [" The build failed with an error.", " Session-only model: anthropic/claude-haiku-4-5.", ...boxEditor("Haiku 4.5")];
		omp = () => {
			vomp.screen = [" The build failed with an error.", " Session-only model: anthropic/claude-sonnet-4-5.", ...boxEditor("Sonnet 4.5")];
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
				...boxEditor("Haiku 4.5"),
			];
			setTimeout(() => report(sonnetState), 1500);
		};
		await expect(switchToSonnet()).resolves.toBe(true);
		expect(toast).not.toHaveBeenCalled();
		expect(listeners.size).toBe(0);
	});

	it("warns when omp never reports the new model", async () => {
		omp = () => {
			vomp.screen = [" Error: No API key for anthropic/claude-sonnet-4-5", ...boxEditor("Haiku 4.5")];
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

	it("refuses a visible menu before typing a switch command", async () => {
		overlays = 1;
		vomp.focus = { overlays: 1, focused: "picker", overlayKinds: ["picker"], altScreen: false };
		await expect(switchToSonnet()).resolves.toBe(false);
		expect(commands).toEqual([]);
		expect(toast).toHaveBeenCalledExactlyOnceWith({ tone: "err", message: expect.stringContaining("omp has a menu open") });
		expect(vomp.diagnostics).toEqual([]);
	});

	it("refuses a fresh overlay after waiting for the editor despite a cached zero overlay count", async () => {
		vomp.screen = [];
		setTimeout(() => {
			vomp.screen = boxEditor("Haiku 4.5");
			vomp.focus = { overlays: 1, focused: "picker", overlayKinds: ["picker"], altScreen: false };
		}, 120);
		await expect(switchToSonnet()).resolves.toBe(false);
		expect(overlays).toBe(0);
		expect(commands).toEqual([]);
		expect(toast).toHaveBeenCalledExactlyOnceWith({ tone: "err", message: expect.stringContaining("omp has a menu open") });
		expect(vomp.diagnostics).toEqual([]);
	});

	it("uses fresh readiness when the cached snapshot still reports a closed menu", async () => {
		overlays = 1;
		omp = () => report(sonnetState);
		await expect(switchToSonnet()).resolves.toBe(true);
		expect(commands).toEqual(["/switch anthropic/claude-sonnet-4-5"]);
		expect(toast).not.toHaveBeenCalled();
	});

	it.each(["unavailable", "error"] as const)("refuses %s focus without claiming a menu is open", async reason => {
		if (reason === "error") vomp.focusError = new Error("TUI debug focus timed out");
		else vomp.focus = null;
		await expect(switchToSonnet()).resolves.toBe(false);
		expect(commands).toEqual([]);
		expect(toast).toHaveBeenCalledExactlyOnceWith({
			tone: "err",
			message: reason === "error" ? "TUI debug focus timed out" : expect.stringContaining("could not check omp's editor focus"),
		});
		expect(vomp.diagnostics).toEqual([]);
	});

	it("reports an unreadable status separately from a menu and logs only the border", async () => {
		vomp.screen = ["Private transcript text", "╭── π ▶ custom model symbol ──╮", "╰─                           ─╯"];
		await expect(switchToSonnet()).resolves.toBe(false);
		expect(commands).toEqual([]);
		expect(toast).toHaveBeenCalledExactlyOnceWith({ tone: "err", message: expect.stringContaining("could not read omp's status line") });
		expect(vomp.diagnostics).toEqual(["╭── π ▶ custom model symbol ──╮"]);
	});

	it("preserves debug-channel errors instead of claiming a menu is open", async () => {
		vomp.screenError = new Error("TUI debug text timed out");
		await expect(switchToSonnet()).resolves.toBe(false);
		expect(commands).toEqual([]);
		expect(toast).toHaveBeenCalledExactlyOnceWith({ tone: "err", message: "TUI debug text timed out" });
		expect(vomp.diagnostics).toEqual([]);
	});

	it("switches from omp's painted default band composer", async () => {
		vomp.screen = bandEditor;
		omp = () => report(sonnetState);
		await expect(switchToSonnet()).resolves.toBe(true);
		expect(commands).toEqual(["/switch anthropic/claude-sonnet-4-5"]);
		expect(toast).not.toHaveBeenCalled();
	});
});

describe("configuredThinking", () => {
	const change = (thinkingLevel: string, configured?: string) =>
		({ type: "thinking_level_change", id: thinkingLevel, parentId: null, timestamp: "", thinkingLevel, configured }) as unknown as SessionEntry;

	it("keeps Auto while omp paints the level Auto resolved", () => {
		expect(configuredThinking("auto", [], "high")).toBe("auto");
		expect(configuredThinking(null, [change("high", "auto")], "high")).toBe("auto");
	});

	it("trusts omp's latest event over an older entry", () => {
		expect(configuredThinking("high", [change("high", "auto")], "high")).toBe("high");
		expect(configuredThinking(null, [change("high", "auto"), change("low", "low")], "low")).toBe("low");
	});

	it("trusts concrete collab selectors and branch entries over a stale displayed effort", () => {
		expect(configuredThinking("low", [change("high", "auto")], "high")).toBe("low");
		expect(configuredThinking("high", [change("low")], "low")).toBe("high");
		expect(configuredThinking(null, [change("low")], "high")).toBe("low");
		expect(configuredThinking(null, [], "high")).toBe("high");
	});

	it("falls back to the recorded level when nothing is painted", () => {
		expect(configuredThinking(null, [change("medium")], null)).toBe("medium");
		expect(configuredThinking(null, [], null)).toBeNull();
	});

	it("ignores Auto recorded on a branch the chat rewound away from", () => {
		const at = (id: string, parentId: string | null, extra: object) => ({ id, parentId, timestamp: "", ...extra }) as unknown as SessionEntry;
		const entries = [
			at("a", null, { type: "message", message: { role: "user", content: "first" } }),
			at("b", "a", { type: "thinking_level_change", thinkingLevel: "high", configured: "high" }),
			at("c", "b", { type: "thinking_level_change", thinkingLevel: "low", configured: "auto" }),
		];
		const view = { guest: { phase: "live", entries }, displayLeaf: "b", history: null, carryover: null } as never;
		expect(configuredThinking(null, displayedEntries(view), "high")).toBe("high");
	});
});

describe("setThinking", () => {
	const choices = ["off", "auto", "low", "medium", "high"] as const;
	/** omp in Auto, which resolved `low` for the latest turn: the status line paints `low`. */
	let selected: (typeof choices)[number];
	let pressed: string[];
	const paint = () => {
		vomp.screen = boxEditor("Sonnet 4.5", selected === "auto" ? "low" : selected);
	};
	const autoChat = {
		hostId: "h1",
		whenLive: async () => undefined,
		keys: async (keys: string) => {
			pressed.push(keys);
			const steps = keys.split(" ").length;
			selected = choices[(choices.indexOf(selected) + steps) % choices.length] ?? selected;
			paint();
		},
		getSnapshot: () => ({ host: { tui: { overlays: 0 } }, guest: { thinkingSelector: selected, entries: [], state: {} } }),
	} as unknown as SessionController;

	beforeEach(() => {
		selected = "auto";
		pressed = [];
		paint();
	});

	it("leaves Auto for the level Auto currently paints", async () => {
		const result = setThinking(autoChat, "low", choices);
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(result).resolves.toBe(true);
		expect(pressed).toEqual(["S-tab"]);
		expect(selected).toBe("low");
	});

	it("cycles thinking from omp's painted default band composer", async () => {
		selected = "high";
		vomp.screen = bandEditor;
		const result = setThinking(autoChat, "off", choices);
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(result).resolves.toBe(true);
		expect(pressed).toEqual(["S-tab"]);
		expect(selected).toBe("off");
		expect(toast).not.toHaveBeenCalled();
	});

	it("refuses a fresh overlay after waiting for the editor without sending thinking keys", async () => {
		vomp.screen = [];
		setTimeout(() => {
			paint();
			vomp.focus = { overlays: 1, focused: "picker", overlayKinds: ["picker"], altScreen: false };
		}, 120);
		const result = setThinking(autoChat, "high", choices);
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(result).resolves.toBe(false);
		expect(autoChat.getSnapshot().host?.tui?.overlays).toBe(0);
		expect(pressed).toEqual([]);
		expect(toast).toHaveBeenCalledExactlyOnceWith({ tone: "err", message: expect.stringContaining("omp has a menu open") });
		expect(vomp.diagnostics).toEqual([]);
	});

	it.each(["unavailable", "error"] as const)("refuses %s focus without sending thinking keys or claiming a menu", async reason => {
		if (reason === "error") vomp.focusError = new Error("TUI debug focus timed out");
		else vomp.focus = null;
		const result = setThinking(autoChat, "high", choices);
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(result).resolves.toBe(false);
		expect(pressed).toEqual([]);
		expect(toast).toHaveBeenCalledExactlyOnceWith({
			tone: "err",
			message: reason === "error" ? "TUI debug focus timed out" : expect.stringContaining("could not check omp's editor focus"),
		});
		expect(vomp.diagnostics).toEqual([]);
	});

	it("reports an unreadable thinking control once without sending cycle keys", async () => {
		vomp.screen = ["╭── π ▶ ⬢ Sonnet 4.5 ▶ proj ──╮", "╰─                          ─╯"];
		selected = "off";
		const result = setThinking(autoChat, "high", choices);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(result).resolves.toBe(false);
		expect(pressed).toEqual([]);
		expect(toast).toHaveBeenCalledExactlyOnceWith({ tone: "err", message: expect.stringContaining("could not read omp's status line") });
	});

	it("reports an unconfirmed cycle once", async () => {
		const unresponsive = { ...autoChat, keys: async (keys: string) => { pressed.push(keys); } } as unknown as SessionController;
		const result = setThinking(unresponsive, "high", choices);
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(result).resolves.toBe(false);
		expect(pressed.length).toBeGreaterThan(0);
		expect(toast).toHaveBeenCalledExactlyOnceWith({ tone: "warn", message: "omp could not switch to that thinking level." });
	});

});
