import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
	const storage = new Map<string, string>();
	/** Pending `term:start` calls, resolved by the test to stand in for slow IPC. */
	const termStarts: ((termId: string) => void)[] = [];
	const localStorage = {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
	};
	const invoke = (channel: string): Promise<unknown> => {
		if (channel !== "term:start") return Promise.resolve(channel === "fs:exists" ? true : []);
		const { promise, resolve } = Promise.withResolvers<string>();
		termStarts.push(resolve);
		return promise;
	};
	vi.stubGlobal("localStorage", localStorage);
	vi.stubGlobal("window", {
		localStorage,
		innerWidth: 1600,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		vomp: { on: () => () => undefined, invoke },
	});
	return { storage, termStarts };
});

vi.mock("./session", () => ({
	SessionController: class {
		hostId = null;
		inputSent = false;
		constructor(options: object) {
			Object.assign(this, options);
		}
		subscribe() {
			return () => undefined;
		}
		getSnapshot() {
			return { mode: "history", working: false, queue: [] };
		}
		async loadHistory() {}
		async checkOwnership() {}
		async ensureLive() {}
		async dispose() {}
	},
}));
vi.mock("../registry/guards", () => ({ confirmTabClose: async () => true }));
vi.mock("../shell/hooks", () => ({ chatTitle: () => null }));
vi.mock("../chat/composer/drafts", () => ({
	useComposerDrafts: { getState: () => ({ drafts: {}, attachments: {}, modes: {}, forget() {}, setDraft() {}, addAttachments() {}, setMode() {}, focus() {} }) },
}));

const STORE = "visual-omp:layout";
const tabs = [
	{ id: "a", projectPath: "/p", sessionFile: "/s/a.jsonl", title: "A" },
	{ id: "b", projectPath: "/p", sessionFile: "/s/b.jsonl", title: "B" },
];

/**
 * The app store as a fresh window loads it from what is saved now. Imported after a module reset, since the store
 * reads storage once when its module loads; modules that use the store (the terminal starter) are imported the same
 * way after it, so they bind to this store and not an earlier test's.
 */
async function loadApp() {
	vi.resetModules();
	return import("./app");
}

beforeEach(() => {
	env.storage.clear();
});

describe("side panel per chat", () => {
	it("keeps each chat's panel to itself, and a chat that never opened it shows it closed at the default width", async () => {
		const { useApp, currentDock } = await loadApp();
		useApp.setState({ tabs, activeTabId: "a", view: "chat" });
		useApp.getState().showPane("tasks");
		useApp.getState().setDockWidth(560);
		expect(currentDock(useApp.getState())).toEqual({ open: true, pane: "tasks", width: 560 });

		useApp.setState({ activeTabId: "b" });
		expect(currentDock(useApp.getState())).toEqual({ open: false, pane: "diff", width: 420 });
		useApp.getState().toggleDock();
		useApp.getState().setDockWidth(380);

		useApp.setState({ activeTabId: "a" });
		expect(currentDock(useApp.getState())).toEqual({ open: true, pane: "tasks", width: 560 });
	});

	it("opens a pane in the chat a request came from, not the one on show", async () => {
		const { useApp, currentDock } = await loadApp();
		useApp.setState({ tabs, activeTabId: "a", view: "chat" });
		useApp.getState().showPane("files", "b");
		expect(currentDock(useApp.getState()).open).toBe(false);
		expect(useApp.getState().docks.b).toEqual({ open: true, pane: "files", width: 420 });
	});

	it("focuses the other half of a split when its chat asks, so its panel shows", async () => {
		const { useApp, currentDock } = await loadApp();
		useApp.setState({ tabs, activeTabId: "a", splitTabId: "b", focusedSplit: "primary", view: "chat" });
		useApp.getState().showPane("files", "b");
		expect(useApp.getState().focusedSplit).toBe("secondary");
		expect(currentDock(useApp.getState())).toEqual({ open: true, pane: "files", width: 420 });
	});

	it("brings an unseen panel into view on its chat's toggle, and closes only the one on screen", async () => {
		const { useApp, currentDock } = await loadApp();
		useApp.setState({ tabs, activeTabId: "a", splitTabId: "b", focusedSplit: "primary", view: "chat" });
		useApp.getState().showPane("tasks", "b");
		useApp.getState().focusSplit("primary");
		// Keyboard activation of B's toggle while A is focused: no pointer event focused B first.
		useApp.getState().toggleDock(undefined, "b");
		expect(useApp.getState().focusedSplit).toBe("secondary");
		expect(currentDock(useApp.getState())).toEqual({ open: true, pane: "tasks", width: 420 });
		// Now on screen, the same toggle closes it, and closing moves no focus.
		useApp.getState().toggleDock(undefined, "b");
		expect(useApp.getState().docks.b).toEqual({ open: false, pane: "tasks", width: 420 });
		useApp.getState().showPane("files", "b");
		useApp.getState().focusSplit("primary");
		useApp.getState().toggleDock(false, "b");
		expect(useApp.getState().focusedSplit).toBe("primary");
	});

	it("brings back a panel standing aside for the chat at a narrow width instead of closing it", async () => {
		const { useApp, dockVisible } = await loadApp();
		useApp.setState({ tabs, activeTabId: "a", view: "chat" });
		useApp.getState().showPane("tasks");
		useApp.setState({ chatOverDock: true });
		expect(dockVisible(useApp.getState(), 900)).toBe(false);
		const width = window.innerWidth;
		Object.assign(window, { innerWidth: 900 });
		useApp.getState().toggleDock(undefined, "a");
		Object.assign(window, { innerWidth: width });
		expect(useApp.getState().docks.a?.open).toBe(true);
		expect(useApp.getState().chatOverDock).toBe(false);
	});

	it("opens a terminal in the chat that started it, even after a switch while the shell starts", async () => {
		const { useApp, currentDock } = await loadApp();
		const { newShell } = await import("../features/panes/terminal");
		useApp.setState({ tabs, activeTabId: "a", view: "chat" });
		const started = newShell("/p");
		useApp.setState({ activeTabId: "b" });
		env.termStarts.shift()?.("term-1");
		await started;
		expect(currentDock(useApp.getState())).toEqual({ open: false, pane: "diff", width: 420 });
		expect(useApp.getState().docks.a).toEqual({ open: true, pane: "terminal", width: 420 });
		expect(useApp.getState().docks.b).toBeUndefined();
	});

	it("opens a late terminal in its chat's panel without moving focus to the other half of a split", async () => {
		const { useApp, currentDock } = await loadApp();
		const { newShell } = await import("../features/panes/terminal");
		useApp.setState({ tabs, activeTabId: "a", splitTabId: "b", focusedSplit: "primary", view: "chat" });
		const started = newShell("/p");
		useApp.getState().focusSplit("secondary");
		env.termStarts.shift()?.("term-3");
		await started;
		expect(useApp.getState().focusedSplit).toBe("secondary");
		expect(currentDock(useApp.getState())).toEqual({ open: false, pane: "diff", width: 420 });
		expect(useApp.getState().docks.a).toEqual({ open: true, pane: "terminal", width: 420 });
	});

	it("drops a terminal request from a chat that closed while the shell started", async () => {
		const { useApp } = await loadApp();
		const { newShell } = await import("../features/panes/terminal");
		useApp.setState({ tabs, activeTabId: "a", view: "chat" });
		const started = newShell("/p", "b");
		await useApp.getState().closeTab("b");
		env.termStarts.shift()?.("term-2");
		await started;
		expect(useApp.getState().docks).toEqual({});
	});

	it("shows the panel for the tour's step and closes it again only in the chat it opened in", async () => {
		const { useApp, peekDock } = await loadApp();
		useApp.setState({ tabs, activeTabId: "a", view: "chat" });
		useApp.getState().showPane("files", "b");
		const close = peekDock();
		expect(useApp.getState().docks.a?.open).toBe(true);
		useApp.setState({ activeTabId: "b" });
		close();
		expect(useApp.getState().docks.a).toBeUndefined();
		expect(useApp.getState().docks.b).toEqual({ open: true, pane: "files", width: 420 });

		// A panel that was already open stays open after the step.
		useApp.getState().showPane("tasks", "a");
		useApp.setState({ activeTabId: "a" });
		peekDock()();
		expect(useApp.getState().docks.a?.open).toBe(true);
	});

	it("gives Home and project overviews one panel of their own", async () => {
		const { useApp, currentDock } = await loadApp();
		useApp.setState({ tabs, activeTabId: "a", view: "project" });
		useApp.getState().showPane("diff");
		useApp.setState({ view: "chat" });
		expect(currentDock(useApp.getState()).open).toBe(false);
		useApp.setState({ view: "project" });
		expect(currentDock(useApp.getState()).open).toBe(true);
	});

	it("comes back for each restored chat after a restart, and an unsaved chat's panel is not kept", async () => {
		const first = await loadApp();
		const unsaved = { id: "n", projectPath: "/p", sessionFile: null, title: null };
		first.useApp.setState({ tabs: [...tabs, unsaved], activeTabId: "a", view: "chat" });
		first.useApp.getState().showPane("tasks");
		first.useApp.getState().setDockWidth(560);
		first.useApp.getState().showPane("files", "b");
		first.useApp.getState().showPane("plan", "n");

		const saved = JSON.parse(env.storage.get(STORE) ?? "null");
		expect(saved.version).toBe(2);
		expect(Object.keys(saved.state.docks).sort()).toEqual(["a", "b"]);

		const { useApp } = await loadApp();
		expect(useApp.getState().docks).toEqual({
			a: { open: true, pane: "tasks", width: 560 },
			b: { open: true, pane: "files", width: 420 },
		});
	});

	it("removes a chat's panel when the chat closes, and Reopen closed chat brings it back", async () => {
		const { useApp, currentDock } = await loadApp();
		useApp.setState({ tabs, activeTabId: "a", view: "chat" });
		useApp.getState().showPane("tasks");
		useApp.getState().showPane("files", "b");
		await useApp.getState().closeTab("a");
		expect(Object.keys(useApp.getState().docks)).toEqual(["b"]);

		expect(await useApp.getState().reopenClosedChat()).toBe(true);
		const reopened = useApp.getState().activeTabId;
		expect(reopened).not.toBe("a");
		expect(currentDock(useApp.getState())).toEqual({ open: true, pane: "tasks", width: 420 });
	});

	it("keeps a viewed chat open after the user leaves it once its panel is set up", async () => {
		const { useApp } = await loadApp();
		const [a, b] = tabs;
		useApp.setState({ tabs: [b, a], activeTabId: "a", view: "chat" });
		// Creates the chats' controllers, as for restored chats, and turns the release rule on.
		await useApp.getState().init();
		useApp.getState().showPane("tasks");
		useApp.setState({ activeTabId: "b" });
		expect(useApp.getState().tabs.map(tab => tab.id)).toEqual(["b", "a"]);

		// With its panel closed again it goes back to being a saved row like any chat that was only viewed.
		useApp.setState({ activeTabId: "a" });
		useApp.getState().toggleDock(false);
		useApp.setState({ activeTabId: "b" });
		expect(useApp.getState().tabs.map(tab => tab.id)).toEqual(["b"]);
	});

	it("moves the one panel layout earlier versions saved to the overview, so restored chats start closed", async () => {
		env.storage.set(STORE, JSON.stringify({ version: 1, state: { tabs, activeTabId: "a", dockOpen: true, dockPane: "files", dockWidth: 500 } }));
		const { useApp, currentDock } = await loadApp();
		expect(useApp.getState().docks).toEqual({ overview: { open: true, pane: "files", width: 500 } });
		useApp.setState({ view: "chat" });
		expect(currentDock(useApp.getState()).open).toBe(false);
		expect("dockOpen" in useApp.getState()).toBe(false);
	});

	it.each([
		["a saved state that is null", { version: 2, state: null }],
		["tabs that are not a list", { version: 2, state: { tabs: "a", activeTabId: "a", docks: { a: { open: true, pane: "tasks", width: 500 } } } }],
		["a version 1 state that is null", { version: 1, state: null }],
	])("opens with defaults from %s", async (_name, saved) => {
		env.storage.set(STORE, JSON.stringify(saved));
		const { useApp } = await loadApp();
		expect(useApp.getState()).toMatchObject({ tabs: [], activeTabId: null, docks: {}, sidebarOpen: true, view: "home" });
	});

	it("drops damaged chat entries and keeps the rest", async () => {
		const [a] = tabs;
		env.storage.set(STORE, JSON.stringify({ version: 2, state: { tabs: [null, a, { id: 3 }], activeTabId: "a", sidebarWidth: "wide", docks: { a: { open: true, pane: "tasks", width: 500 } } } }));
		const { useApp } = await loadApp();
		expect(useApp.getState()).toMatchObject({ tabs: [a], activeTabId: "a", sidebarWidth: 264, docks: { a: { open: true, pane: "tasks", width: 500 } } });
	});
});
