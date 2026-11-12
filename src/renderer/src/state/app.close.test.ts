import type { AgentSnapshot } from "@oh-my-pi/pi-wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatWork, workInFlight } from "./chatWork";
import type { SessionView } from "./session";

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
		vomp: { on: () => () => undefined, invoke: () => Promise.resolve([]) },
	});
	/** Each chat's view, by tab id; the guard's answer; the chats it was asked about. */
	return {
		views: new Map<string, unknown>(), allow: true, asked: [] as string[], storage,
		drafts: {} as Record<string, string>,
		attachments: {} as Record<string, unknown[]>,
		dispose: async (_tabId: string) => {},
	};
});

vi.mock("./session", () => ({
	SessionController: class {
		hostId = null;
		inputSent = false;
		tabId = "";
		constructor(options: object) {
			Object.assign(this, options);
		}
		subscribe() {
			return () => undefined;
		}
		getSnapshot() {
			return env.views.get(this.tabId) ?? { mode: "history", working: false, queue: [] };
		}
		async loadHistory() {}
		async checkOwnership() {}
		async dispose() { await env.dispose(this.tabId); }
		setForeground() {}
	},
}));
vi.mock("../registry/guards", async importOriginal => ({
	...await importOriginal<Record<string, unknown>>(),
	confirmTabClose: async (tabId: string) => {
		env.asked.push(tabId);
		return env.allow;
	},
}));
vi.mock("../shell/hooks", () => ({ chatTitle: () => null }));
vi.mock("../chat/composer/drafts", () => ({
	useComposerDrafts: { getState: () => ({
		drafts: env.drafts, attachments: env.attachments, modes: {},
		forget(id: string) { delete env.drafts[id]; delete env.attachments[id]; },
		setDraft(id: string, text: string) { env.drafts[id] = text; },
		addAttachments() {}, setMode() {}, focus() {},
	}) },
}));

const helper = (id: string, status: AgentSnapshot["status"]): AgentSnapshot =>
	({ id, displayName: id, kind: "sub", status, hasSessionFile: true, createdAt: 0, lastActivity: 0 }) as AgentSnapshot;

/** An open chat on a running omp (or one whose omp exited): replying or not, with these helpers. */
function view(working: boolean, helpers: AgentSnapshot[], mode: SessionView["mode"] = "live"): SessionView {
	return {
		mode,
		working,
		readOnly: false,
		follow: null,
		queue: [],
		guest: { agents: helpers, progress: new Map(), lifecycle: new Map(), uiRequest: null },
	} as unknown as SessionView;
}

const neither = view(false, [helper("Done", "idle")]);
const reply = view(true, []);
const helpers = view(false, [helper("Atlas", "running"), helper("Bolt", "running"), helper("Done", "parked")]);
const both = view(true, [helper("Atlas", "running")]);

describe("workInFlight", () => {
	it("names omp's reply and the helpers working, and nothing for a chat at rest", () => {
		expect([neither, reply, helpers, both].map(workInFlight)).toEqual<(ChatWork | null)[]>([
			null,
			{ replying: true, helpers: 0 },
			{ replying: false, helpers: 2 },
			{ replying: true, helpers: 1 },
		]);
		// Without a running omp a helper the mirror recorded as running has stopped: closing interrupts nothing.
		expect(workInFlight(view(false, [helper("Atlas", "running")], "exited"))).toBeNull();
		expect(workInFlight(null)).toBeNull();
	});
});

describe("closeChat", () => {
	const tabs = ["neither", "reply", "helpers", "both"].map(id => ({ id, projectPath: "/p", sessionFile: null, title: id }));

	beforeEach(() => {
		env.views = new Map<string, unknown>([
			["neither", neither],
			["reply", reply],
			["helpers", helpers],
			["both", both],
		]);
		env.asked = [];
		env.allow = true;
	});

	async function open() {
		vi.resetModules();
		const app = await import("./app");
		app.useApp.setState({ tabs });
		for (const tab of tabs) app.useApp.getState().activateTab(tab.id);
		await Promise.resolve();
		return app;
	}

	it("asks first while omp replies or helpers work, and closes a chat at rest at once", async () => {
		const { closeChat, useApp } = await open();
		for (const tab of tabs) await closeChat(tab.id);
		expect(env.asked).toEqual(["reply", "helpers", "both"]);
		expect(useApp.getState().tabs).toEqual([]);
	});

	it("keeps a chat with helpers at work open when the answer is to keep waiting", async () => {
		const { closeChat, useApp } = await open();
		env.allow = false;
		await closeChat("helpers");
		expect(env.asked).toEqual(["helpers"]);
		expect(useApp.getState().tabs.map(tab => tab.id)).toContain("helpers");
	});
});

describe("bulk close and manual tab order", () => {
	beforeEach(() => {
		env.storage.clear();
		env.views.clear();
		env.drafts = {};
		env.attachments = {};
		env.dispose = async () => {};
	});

	async function open(count = 3) {
		vi.resetModules();
		const app = await import("./app");
		const tabs = Array.from({ length: count }, (_, index) => ({ id: `saved${index}`, projectPath: "/p", sessionFile: `/${index}.jsonl`, title: `Chat ${index}` }));
		app.useApp.setState({ tabs, activeTabId: null, splitTabId: null, view: "home" });
		for (const tab of tabs) app.useApp.getState().activateTab(tab.id);
		const guards = await import("../registry/guards");
		return { ...app, tabs, guards };
	}

	it("leaves every chat and draft open on Cancel, then awaits each disposal before closing the next", async () => {
		const { closeAllChats, useApp, tabs, guards } = await open();
		env.drafts = { saved0: "First draft" };
		env.attachments = { saved0: [{}] };
		guards.setBulkCloseGuard(async () => null);
		expect(await closeAllChats()).toBeNull();
		expect(useApp.getState().tabs).toEqual(tabs);
		expect(env.drafts.saved0).toBe("First draft");
		expect(env.attachments.saved0).toHaveLength(1);

		const decision = Promise.withResolvers<void>();
		const stopped: string[] = [];
		env.dispose = async id => { stopped.push(id); if (id === "saved0") await decision.promise; };
		const guard = vi.fn(async (tabIds: readonly string[]) => ({ tabIds, stillIdle: null }));
		guards.setBulkCloseGuard(guard);
		const closing = closeAllChats();
		expect(closeAllChats()).toBe(closing);
		await Promise.resolve();
		expect(stopped).toEqual(["saved0"]);
		expect(useApp.getState().tabs.map(tab => tab.id)).toEqual(["saved1", "saved2"]);
		decision.resolve();
		expect(await closing).toBe(3);
		expect(guard).toHaveBeenCalledExactlyOnceWith(["saved0", "saved1", "saved2"], "all");
		expect(stopped).toEqual(["saved0", "saved1", "saved2"]);
		expect(useApp.getState().tabs).toEqual([]);
		expect(env.attachments).toEqual({});
		for (const file of ["/2.jsonl", "/1.jsonl", "/0.jsonl"]) {
			expect(await useApp.getState().reopenClosedChat()).toBe(true);
			expect(useApp.getState().tabs.at(-1)?.sessionFile).toBe(file);
		}
		expect(env.drafts[useApp.getState().tabs.at(-1)!.id]).toBe("First draft");
	});

	it("keeps only the last ten saved chats on the reopen stack after a larger bulk close", async () => {
		const { closeAllChats, useApp, guards } = await open(12);
		guards.setBulkCloseGuard(async tabIds => ({ tabIds, stillIdle: null }));
		await closeAllChats();
		for (let index = 11; index >= 2; index--) {
			expect(await useApp.getState().reopenClosedChat()).toBe(true);
			expect(useApp.getState().tabs.at(-1)?.sessionFile).toBe(`/${index}.jsonl`);
		}
		expect(await useApp.getState().reopenClosedChat()).toBe(false);
	});

	it("closes only the approved chats in the given order, skips one that stopped being idle, and reports what stayed open", async () => {
		const { closeChats, useApp, guards } = await open(4);
		const busy = new Set<string>();
		const done = vi.fn();
		const stopped: string[] = [];
		env.dispose = async id => {
			stopped.push(id);
			// Closing the first chat gives saved2 time to start working before its own turn.
			if (id === "saved3") busy.add("saved2");
		};
		const guard = vi.fn(async (tabIds: readonly string[]) => ({ tabIds: tabIds.filter(id => id !== "saved1"), stillIdle: (id: string) => !busy.has(id), done }));
		guards.setBulkCloseGuard(guard);
		expect(await closeChats(["saved3", "missing", "saved1", "saved2"], "selected")).toBe(1);
		expect(guard).toHaveBeenCalledExactlyOnceWith(["saved3", "saved1", "saved2"], "selected");
		expect(stopped).toEqual(["saved3"]);
		expect(useApp.getState().tabs.map(tab => tab.id)).toEqual(["saved0", "saved1", "saved2"]);
		expect(done).toHaveBeenCalledExactlyOnceWith(1, 2);
		expect(await closeChats(["missing"], "selected")).toBeNull();
		expect(guard).toHaveBeenCalledOnce();
	});

	it("shares a running bulk close only with the same request; a different one waits and asks about its own chats", async () => {
		const { closeChats, useApp, guards } = await open(3);
		const first = Promise.withResolvers<null>();
		const asked: (readonly string[])[] = [];
		guards.setBulkCloseGuard(async tabIds => {
			asked.push(tabIds);
			return asked.length === 1 ? first.promise : { tabIds, stillIdle: null };
		});
		const selected = closeChats(["saved0"], "selected");
		expect(closeChats(["saved0"], "selected")).toBe(selected);
		const other = closeChats(["saved1"], "selected");
		expect(other).not.toBe(selected);
		await Promise.resolve();
		expect(asked).toEqual([["saved0"]]);
		first.resolve(null);
		expect(await selected).toBeNull();
		expect(await other).toBe(1);
		expect(asked).toEqual([["saved0"], ["saved1"]]);
		expect(useApp.getState().tabs.map(tab => tab.id)).toEqual(["saved0", "saved2"]);
	});

	it("moves tabs without changing the focused chat, and restores their new saved order", async () => {
		const { useApp } = await open();
		const active = useApp.getState().activeTabId;
		useApp.getState().moveTab("saved2", 0);
		expect(useApp.getState().tabs.map(tab => tab.id)).toEqual(["saved2", "saved0", "saved1"]);
		expect(useApp.getState().activeTabId).toBe(active);
		const saved = env.storage.get("visual-omp:layout")!;
		expect(JSON.parse(saved).state.tabs.map((tab: { id: string }) => tab.id)).toEqual(["saved2", "saved0", "saved1"]);
		useApp.setState({ tabs: [] });
		// Hydration uses the layout written by moveTab, without constructing replacement saved data.
		env.storage.set("visual-omp:layout", saved);
		await useApp.persist.rehydrate();
		expect(useApp.getState().tabs.map(tab => tab.id)).toEqual(["saved2", "saved0", "saved1"]);
		useApp.getState().moveTab("saved2", 99);
		expect(useApp.getState().tabs.map(tab => tab.id)).toEqual(["saved0", "saved1", "saved2"]);
	});
});
