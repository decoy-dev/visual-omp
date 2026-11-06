import { beforeEach, describe, expect, it, vi } from "vitest";
import { commandChatFolder, defaultChatFolder } from "@shared/chatFolder";
import type { Platform } from "@shared/ipc";

const env = vi.hoisted(() => {
	const storage = new Map<string, string>();
	const localStorage = {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
	};
	const invoke = vi.fn(async (_channel: string): Promise<unknown> => []);
	vi.stubGlobal("localStorage", localStorage);
	vi.stubGlobal("window", { localStorage, vomp: { invoke, on: () => () => undefined } });
	return { storage, invoke };
});
vi.mock("./session", () => ({
	SessionController: class {
		hostId = null;
		constructor(options: object) { Object.assign(this, options); }
		projectPath = "";
		restoreProjectPath(path: string) { this.projectPath = path; }
		async loadHistory() {}
		async checkOwnership() {}
		subscribe() { return () => undefined; }
		getSnapshot() { return { mode: "history", working: false, queue: [] }; }
		async ensureLive() {}
		async dispose() {}
		setForeground() {}
	},
}));
vi.mock("../registry/guards", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), confirmTabClose: async () => true }));
vi.mock("../shell/hooks", () => ({ chatTitle: () => null }));
vi.mock("../chat/composer/send", () => ({ deliver: vi.fn() }));
vi.mock("../features/session-tools/slash", () => ({ routeSlash: vi.fn() }));
vi.mock("../features/session-tools/typed", () => ({ sendSlashCommand: vi.fn() }));
vi.mock("../i18n", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("../ui", () => ({ toast: vi.fn() }));

beforeEach(() => {
	env.storage.clear();
	vi.resetModules();
	env.invoke.mockReset();
});

async function loadApp(platform: Platform = "darwin") {
	const folder = defaultChatFolder(platform, "C:\\Users\\Chris\\AppData\\Local\\Temp");
	env.invoke.mockImplementation(async channel => channel === "app:info" ? { defaultChatFolder: folder } : []);
	// The store hydrates at import time, so each test loads it after resetting its storage and module cache.
	return { ...(await import("./app")), folder };
}

describe("chat entry point folders", () => {
	it.each(["darwin", "win32"] as const)("sidebar's unscoped newChat uses the %s default instead of the active project", async platform => {
		const { useApp, folder } = await loadApp(platform);
		useApp.setState({ activeProject: "/project", view: "chat" });
		const id = await useApp.getState().newChat();
		expect(useApp.getState().tabs.find(tab => tab.id === id)?.projectPath).toBe(folder);
	});
	it("uses the initialized folder without another IPC request", async () => {
		const { useApp } = await loadApp();
		useApp.setState({ defaultChatFolder: "/tmp", activeProject: "/last" });
		await useApp.getState().newChat();
		expect(env.invoke).not.toHaveBeenCalled();
	});
	it("starts on first run without projects or an active project", async () => {
		const { useApp } = await loadApp();
		const id = await useApp.getState().newChat();
		expect(id).not.toBeNull();
		expect(useApp.getState().tabs[0].projectPath).toBe("/tmp");
	});
	it("keeps an explicitly supplied project folder", async () => {
		const { useApp } = await loadApp();
		useApp.setState({ defaultChatFolder: "/tmp", activeProject: "/last" });
		const id = await useApp.getState().newChat("/chosen");
		expect(useApp.getState().tabs.find(tab => tab.id === id)?.projectPath).toBe("/chosen");
	});
	it("uses the focused split for the command and keeps the primary project for a fresh side-by-side chat", async () => {
		const { useApp, focusedTabId } = await loadApp();
		const primary = await useApp.getState().newChat("/primary");
		useApp.getState().toggleSplit();
		expect(useApp.getState().tabs[1].projectPath).toBe("/primary");
		const secondary = await useApp.getState().newChat("/secondary", { split: true });
		const state = useApp.getState();
		expect(focusedTabId(state)).toBe(secondary);
		const focused = state.tabs.find(tab => tab.id === focusedTabId(state));
		expect(commandChatFolder(state.view, focused?.projectPath ?? null, state.activeProject)).toBe("/secondary");
		expect(state.activeTabId).toBe(primary);
	});
	it("registers and picks a first-run Home folder without changing activeProject", async () => {
		const { useApp } = await loadApp();
		// Bind the real Home actions and draft store to the fresh app module loaded for this test.
		const { registerDraftProject } = await import("../features/projects/actions");
		const { useComposerDrafts } = await import("../chat/composer/drafts");
		env.invoke.mockImplementation(async channel => channel === "sessions:projects"
			? [{ path: "/canonical", name: "canonical", sessionCount: 0, lastActivity: 0, exists: true }]
			: channel === "project:add" ? { path: "/canonical" } : []);
		const path = await registerDraftProject("/picked");
		useComposerDrafts.getState().setHomeFolder(path);
		expect(env.invoke).toHaveBeenCalledWith("project:add", "/picked");
		expect(useApp.getState().projects[0].path).toBe("/canonical");
		expect(useComposerDrafts.getState().homeFolder).toBe("/canonical");
		expect(useApp.getState().activeProject).toBeNull();
	});
});

it("resolves saved project references before discovery without starting omp", async () => {
	const { useApp, controllerFor } = await loadApp();
	const tabs = [{ id: "restored", projectPath: "/private/tmp/project", sessionFile: "/saved/chat.jsonl", title: null }];
	env.storage.set("visual-omp:layout", JSON.stringify({ state: { tabs, activeTabId: "restored", activeProject: tabs[0].projectPath, expandedProjects: [tabs[0].projectPath, "/tmp/project"] }, version: 2 }));
	// Reload after seeding localStorage to exercise synchronous hydration at module initialization.
	vi.resetModules();
	const restored = await import("./app");
	env.invoke.mockImplementation(async (channel, ...args: unknown[]) => {
		if (channel === "app:info") return { defaultChatFolder: "/tmp" };
		if (channel === "project:paths") return (args[0] as string[]).map(path => path.replace("/private/tmp/", "/tmp/"));
		if (channel === "sessions:projects") {
			expect(restored.useApp.getState().tabs[0].projectPath).toBe("/tmp/project");
			expect(restored.controllerFor("restored")?.projectPath).toBe("/tmp/project");
		}
		return [];
	});
	await restored.useApp.getState().init();
	expect(restored.useApp.getState()).toMatchObject({ tabs: [{ projectPath: "/tmp/project" }], activeProject: "/tmp/project", expandedProjects: ["/tmp/project"] });
	expect(env.invoke).not.toHaveBeenCalledWith("host:start", expect.anything());
	expect(useApp).not.toBe(restored.useApp);
	expect(controllerFor("restored")).toBeNull();
});
