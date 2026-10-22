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
	return { views: new Map<string, unknown>(), allow: true, asked: [] as string[] };
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
		async dispose() {}
	},
}));
vi.mock("../registry/guards", () => ({
	confirmTabClose: async (tabId: string) => {
		env.asked.push(tabId);
		return env.allow;
	},
}));
vi.mock("../shell/hooks", () => ({ chatTitle: () => null }));
vi.mock("../chat/composer/drafts", () => ({
	useComposerDrafts: { getState: () => ({ drafts: {}, attachments: {}, modes: {}, forget() {}, setDraft() {}, addAttachments() {}, setMode() {}, focus() {} }) },
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
