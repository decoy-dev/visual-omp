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
		localStorage,
		innerWidth: 1600,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		vomp: { on: () => () => undefined, invoke: async () => [] },
	});
	return { storage };
});

vi.mock("../../state/session", () => ({
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
vi.mock("../../registry/guards", () => ({ confirmTabClose: async () => true }));
vi.mock("../../shell/hooks", () => ({ chatTitle: () => null }));
vi.mock("../../chat/composer/drafts", () => ({
	useComposerDrafts: { getState: () => ({ drafts: {}, attachments: {}, modes: {}, forget() {}, setDraft() {}, addAttachments() {}, setMode() {}, focus() {} }) },
}));

const P = "/p";
const tabs = [
	{ id: "a", projectPath: P, sessionFile: "/s/a.jsonl", title: "A" },
	{ id: "b", projectPath: P, sessionFile: "/s/b.jsonl", title: "B" },
];

/**
 * A fresh app store and Files store. Imported after a module reset so each test starts from empty stores; the Files
 * store is imported after the app store so it binds to the same one.
 */
async function load() {
	vi.resetModules();
	const app = await import("../../state/app");
	const files = await import("./files-store");
	app.useApp.setState({ tabs, activeTabId: "a", view: "chat" });
	return { ...app, ...files };
}

beforeEach(() => {
	env.storage.clear();
});

describe("Files pane state per chat", () => {
	it("keeps tabs, folders, the hidden tree and the tree width to each chat in the same project", async () => {
		const { useFiles, filesView, EMPTY_VIEW } = await load();
		const a = filesView("a", P);
		const files = useFiles.getState();
		files.open(a, `${P}/README.md`);
		files.toggle(a, `${P}/src`, true);
		files.setTreeHidden(a, true);
		files.setTreeWidth(a, 300);
		expect(useFiles.getState().byView[a]).toEqual({ expanded: [`${P}/src`], tabs: [`${P}/README.md`], active: `${P}/README.md`, treeHidden: true, treeWidth: 300 });
		expect(useFiles.getState().byView[filesView("b", P)] ?? EMPTY_VIEW).toEqual(EMPTY_VIEW);
	});

	it("keeps the tree width within its limits", async () => {
		const { useFiles, filesView, TREE_MAX_WIDTH, TREE_MIN_WIDTH } = await load();
		useFiles.getState().setTreeWidth(filesView("a", P), 9000);
		expect(useFiles.getState().byView.a?.treeWidth).toBe(TREE_MAX_WIDTH);
		useFiles.getState().setTreeWidth(filesView("a", P), 1);
		expect(useFiles.getState().byView.a?.treeWidth).toBe(TREE_MIN_WIDTH);
	});

	it("opens a file link in the Files pane and side panel of the chat it came from", async () => {
		const { useApp, useFiles, openInFiles } = await load();
		openInFiles(P, `${P}/src/app.ts/`, { focus: true, tabId: "b" });
		expect(useFiles.getState().byView.b).toMatchObject({ tabs: [`${P}/src/app.ts`], treeHidden: true });
		expect(useFiles.getState().byView.a).toBeUndefined();
		expect(useApp.getState().docks).toEqual({ b: { open: true, pane: "files", width: 420 } });
	});

	it("gives project overviews their own Files state, apart from the chats in that project", async () => {
		const { useApp, useFiles, openInFiles } = await load();
		useApp.setState({ view: "project" });
		openInFiles(P, `${P}/README.md`);
		expect(Object.keys(useFiles.getState().byView)).toEqual([`project:${P}`]);
		expect(useApp.getState().docks).toEqual({ overview: { open: true, pane: "files", width: 420 } });
	});

	it("drops a chat's Files state when the chat closes, and ignores a request that arrives after", async () => {
		const { useApp, useFiles, openInFiles } = await load();
		openInFiles(P, `${P}/README.md`, { tabId: "a" });
		openInFiles(P, `${P}/README.md`, { tabId: "b" });
		await useApp.getState().closeTab("a");
		expect(Object.keys(useFiles.getState().byView)).toEqual(["b"]);

		openInFiles(P, `${P}/src/app.ts`, { focus: true, tabId: "a" });
		expect(Object.keys(useFiles.getState().byView)).toEqual(["b"]);
		expect(Object.keys(useApp.getState().docks)).toEqual(["b"]);
	});
});
