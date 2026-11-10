import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController } from "../../state/session";
import { screenActivity } from "../../state/tsp/screen-activity";
import { press, readyEditor, waitForScreen } from "./drive";
import { loadTree, navigateTo } from "./navigate";
vi.mock("../../state/app", () => ({ controllerFor: vi.fn(), useApp: {} }));
const drafts = vi.hoisted(() => ({ setDraft: vi.fn(), focus: vi.fn() }));
vi.mock("../../chat/composer/drafts", () => ({ useComposerDrafts: { getState: () => drafts } }));
vi.mock("./drive", () => ({ OmpBusyError: class extends Error {}, press: vi.fn(), readScreen: vi.fn(), readyEditor: vi.fn(), sleep: vi.fn(), waitForScreen: vi.fn() }));
const invoke = vi.fn();
beforeEach(() => {
	vi.mocked(press).mockReset();
	vi.mocked(readyEditor).mockReset();
	vi.mocked(waitForScreen).mockReset();
	drafts.setDraft.mockClear(); drafts.focus.mockClear();
	invoke.mockReset().mockImplementation(async (channel: string, file: string) => {
		if (channel === "sessions:resolve") return "/project/sibling.jsonl";
		const ids = file === "/project/sibling.jsonl" ? ["shared", "sibling-only"] : ["shared"];
		return ids.map(id => JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-29T12:00:00.000Z", message: { role: "user", content: id } })).join("\n");
	});
	vi.stubGlobal("window", { vomp: { invoke } });
});
describe("loadTree physical identity", () => {
	it("keeps a live predecessor's tree separate from a newer sibling", async () => {
		const session = { sessionFile: "/project/original.jsonl", getSnapshot: () => ({ host: { phase: "live" }, displayLeaf: null }) } as unknown as SessionController;
		const tree = await loadTree(session);
		expect(tree.entries.has("shared")).toBe(true);
		expect(tree.entries.has("sibling-only")).toBe(false);
		expect(invoke).not.toHaveBeenCalledWith("sessions:resolve", expect.anything());
	});
	it("resolves a saved view to the linked sibling", async () => {
		const session = { sessionFile: "/project/original.jsonl", getSnapshot: () => ({ host: null, displayLeaf: null }) } as unknown as SessionController;
		expect((await loadTree(session)).entries.has("sibling-only")).toBe(true);
	});
});

it("refuses a missing TSP session entry before opening the selector", async () => {
	const command = vi.fn();
	const session = { sessionFile: "/project/original.jsonl", getSnapshot: () => ({ host: { transport: "tsp", phase: "live" }, working: false }), command } as unknown as SessionController;
	await expect(navigateTo(session, "entry")).rejects.toThrow("no longer in this chat");
	expect(command).not.toHaveBeenCalled();
});

describe("classic navigation drive ownership", () => {
	const scope = { hostId: "classic-host", generation: 1, epoch: null };
	const listeners = new Set<() => void>();
	let host = { hostId: scope.hostId, generation: scope.generation, phase: "live" };
	const command = vi.fn();
	const setDisplayLeaf = vi.fn();
	const session = {
		tabId: "chat", sessionFile: "/project/original.jsonl",
		getSnapshot: () => ({ host, working: false, displayLeaf: null }),
		subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		command, setDisplayLeaf,
	} as unknown as SessionController;

	beforeEach(() => {
		host = { hostId: scope.hostId, generation: scope.generation, phase: "live" };
		listeners.clear(); command.mockReset(); setDisplayLeaf.mockReset();
		command.mockImplementation(async () => { expect(screenActivity.has(scope, "drive")).toBe(true); });
		vi.mocked(readyEditor).mockImplementation(async () => {
			expect(screenActivity.has(scope, "drive")).toBe(false);
			return [];
		});
		vi.mocked(press).mockImplementation(async () => { expect(screenActivity.has(scope, "drive")).toBe(true); });
	});

	it("holds the unclaimed tree through rewind and preserves its exact key sequence", async () => {
		const { setDraft, focus } = drafts;
		const screens = [
			["Session Tree"],
			["│ › • user: shared"],
			["Navigated to selected point"],
			[" π ▶ ⬢ Sonnet 4.6 · ◒ high ▶ proj ▶─0.3%─", "╰─ "],
		];
		vi.mocked(waitForScreen).mockImplementation(async (_session, test) => {
			expect(screenActivity.has(scope, "drive")).toBe(true);
			const screen = screens.shift()!;
			expect(test(screen)).toBe(true);
			return screen;
		});
		await expect(navigateTo(session, "shared")).resolves.toEqual({ draft: "shared" });
		expect(command).toHaveBeenCalledExactlyOnceWith("/tree");
		expect(vi.mocked(press).mock.calls.map(([, keys]) => keys)).toEqual(["M-u", "home", "enter", "C-c"]);
		expect(setDraft).toHaveBeenCalledExactlyOnceWith("chat", "shared");
		expect(focus).toHaveBeenCalledExactlyOnceWith("chat");
		expect(screenActivity.has(scope, "drive")).toBe(false);
		expect(listeners.size).toBe(0);
	});

	it.each(["refusal", "timeout"] as const)("releases classic drive ownership after %s", async outcome => {
		if (outcome === "refusal") command.mockImplementation(async () => {
			expect(screenActivity.has(scope, "drive")).toBe(true);
			throw new Error("Native command refused");
		});
		else vi.mocked(waitForScreen).mockResolvedValue(null);
		await expect(navigateTo(session, "shared")).rejects.toThrow();
		expect(screenActivity.has(scope, "drive")).toBe(false);
		expect(listeners.size).toBe(0);
		expect(press).not.toHaveBeenCalled();
	});

	it.each(["host", "generation", "exit"] as const)("releases the pinned classic scope immediately on %s invalidation", async change => {
		command.mockImplementation(async () => {
			expect(screenActivity.has(scope, "drive")).toBe(true);
			if (change === "host") host.hostId = "replacement";
			else if (change === "generation") host.generation++;
			else host.phase = "exited";
			for (const listener of listeners) listener();
			expect(screenActivity.has(scope, "drive")).toBe(false);
			throw new Error("Classic scope changed");
		});
		await expect(navigateTo(session, "shared")).rejects.toThrow("Classic scope changed");
		expect(screenActivity.has(scope, "drive")).toBe(false);
		expect(listeners.size).toBe(0);
	});
});
