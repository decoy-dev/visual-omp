import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
	const storage = new Map<string, string>();
	const localStorage = {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
	};
	vi.stubGlobal("localStorage", localStorage);
	vi.stubGlobal("window", {
		localStorage, innerWidth: 1600,
		addEventListener: () => undefined, removeEventListener: () => undefined,
		vomp: { on: () => () => undefined, invoke: () => Promise.resolve([]) },
	});
	const frames: FrameRequestCallback[] = [];
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
	return { storage, frames, dispose: vi.fn(), close: vi.fn() };
});

vi.mock("./session", () => ({
	SessionController: class {
		hostId = null;
		inputSent = false;
		constructor(options: object) { Object.assign(this, options); }
		subscribe() { return () => undefined; }
		getSnapshot() { return { mode: "history", working: false, queue: [] }; }
		async loadHistory() {}
		async checkOwnership() {}
		dispose = env.dispose;
	},
}));
vi.mock("../registry/guards", () => ({ confirmTabClose: env.close }));
vi.mock("../shell/hooks", () => ({ chatTitle: () => null }));

const tabs = [
	{ id: "a", projectPath: "/first", sessionFile: "/s/a.jsonl", title: "First chat" },
	{ id: "b", projectPath: "/second", sessionFile: "/s/b.jsonl", title: "Second chat" },
];
const docks = {
	a: { open: true, pane: "tasks", width: 560 },
	b: { open: false, pane: "files", width: 380 },
};

beforeEach(() => {
	vi.resetModules();
	env.storage.clear();
	env.frames.length = 0;
	env.dispose.mockClear();
	env.close.mockClear();
});

async function open() {
	// A fresh module load exercises layout hydration without carrying a previous test's store or composer editors.
	const app = await import("./app");
	const drafts = await import("../chat/composer/drafts");
	app.useApp.setState({ tabs, activeTabId: "a", splitTabId: "b", focusedSplit: "secondary", activeProject: "/second", view: "chat", docks });
	drafts.useComposerDrafts.getState().setDraft("a", "Unsent first message");
	drafts.useComposerDrafts.getState().setDraft("b", "Unsent second message");
	drafts.useComposerDrafts.getState().addAttachments("b", [{ path: "/image.png", name: "image.png" }]);
	return { ...app, ...drafts };
}

describe("closing split view", () => {
	it.each(["primary", "secondary"] as const)("keeps the %s chat and both chats' layouts, drafts and open tabs", async keep => {
		const { useApp, currentDock, useComposerDrafts } = await open();
		const before = useComposerDrafts.getState();
		useApp.getState().closeSplit(keep);
		const state = useApp.getState();
		const kept = keep === "primary" ? "a" : "b";
		expect(state.activeTabId).toBe(kept);
		expect(state.activeProject).toBe(keep === "primary" ? "/first" : "/second");
		expect(state.splitTabId).toBeNull();
		expect(state.focusedSplit).toBe("primary");
		expect(state.chatOverDock).toBe(true);
		expect(state.tabs).toBe(tabs);
		expect(state.docks).toBe(docks);
		expect(currentDock(state)).toEqual(docks[kept]);
		expect(useComposerDrafts.getState().drafts).toBe(before.drafts);
		expect(useComposerDrafts.getState().attachments).toBe(before.attachments);
		expect(env.close).not.toHaveBeenCalled();
		expect(env.dispose).not.toHaveBeenCalled();
		expect(env.frames).toHaveLength(1);
		env.frames.shift()!(0);
		expect(useComposerDrafts.getState().pendingFocus).toEqual({ [kept]: true });
	});

	it.each(["primary", "secondary"] as const)("keeps the unedited saved partner open after host adoption when keeping %s", async keep => {
		const { useApp, useComposerDrafts } = await open();
		useApp.setState({ docks: {} });
		useComposerDrafts.setState({ drafts: {}, attachments: {} });
		await useApp.getState().init();
		useApp.getState().closeSplit(keep);
		expect(useApp.getState().tabs).toBe(tabs);
		expect(env.dispose).not.toHaveBeenCalled();
	});

	it("focuses a mounted kept composer's editor after the layout changes", async () => {
		const { useApp, registerComposerEditor } = await open();
		const focus = vi.fn();
		const unregister = registerComposerEditor("b", { focus, insertAtCaret() {} });
		useApp.getState().closeSplit("secondary");
		expect(focus).not.toHaveBeenCalled();
		env.frames.shift()!(0);
		expect(focus).toHaveBeenCalledOnce();
		unregister();
	});

	it.each(["primary", "secondary"] as const)("toggleSplit keeps the focused %s chat", async focusedSplit => {
		const { useApp } = await open();
		useApp.setState({ focusedSplit });
		useApp.getState().toggleSplit();
		expect(useApp.getState().activeTabId).toBe(focusedSplit === "primary" ? "a" : "b");
		expect(useApp.getState().tabs).toBe(tabs);
		expect(useApp.getState().splitTabId).toBeNull();
	});

	it("does nothing when no split is open", async () => {
		const { useApp } = await open();
		useApp.setState({ splitTabId: null });
		const before = useApp.getState();
		useApp.getState().closeSplit("secondary");
		expect(useApp.getState()).toBe(before);
		expect(env.frames).toHaveLength(0);
	});
});
