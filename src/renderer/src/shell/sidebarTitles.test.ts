import type { SessionSummary } from "@shared/ipc";
import { describe, expect, it, vi } from "vitest";
import type { ChatTab } from "../state/app";
import type { SessionView } from "../state/session";
import { flatChats, sidebarGroups, type SidebarInput } from "./sidebarRows";
import { sidebarTitles } from "./sidebarTitles";

const labels = { untitledTitle: "Untitled chat", newChatTitle: "New chat" };
const saved = (id: string, title: string | null): SessionSummary => ({
	id, file: `/project/${id}.jsonl`, cwd: "/project", title,
	createdAt: 1, updatedAt: 1, archived: false, preview: null, parentSession: null,
});

function liveController(title: string | null) {
	let view = { history: { title } } as SessionView;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => view,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		emit(title: string | null) {
			view = { ...view, history: { title } } as SessionView;
			for (const listener of listeners) listener();
		},
		listeners,
	};
}

describe("sidebar title snapshots", () => {
	it("updates name ordering and search on a controller-only title change", () => {
		const tabs: ChatTab[] = [{ id: "live", projectPath: "/project", sessionFile: "/project/live.jsonl", title: "Stale tab title" }];
		const sessionsByProject = { "/project": [saved("live", "Saved title"), saved("middle", "Middle")] };
		const controller = liveController("Zulu");
		const source = sidebarTitles(tabs, sessionsByProject, () => controller, labels);
		const input: SidebarInput = {
			projects: [{ path: "/project", name: "Project", lastActivity: 1, sessionCount: 2, exists: true }],
			tabs, sessionsByProject, pinnedProjects: [], expanded: ["/project"], showAll: [], sortBy: "name", query: "", ...labels,
			openTitle: id => source.getSnapshot().get(id) ?? null,
		};
		const notify = vi.fn();
		const stop = source.subscribe(notify);
		const initial = source.getSnapshot();
		expect(flatChats(input).map(chat => chat.key)).toEqual(["/project/middle.jsonl", "/project/live.jsonl"]);
		expect(flatChats({ ...input, query: "Alpha" })).toEqual([]);
		controller.emit("Alpha");
		expect(notify).toHaveBeenCalledOnce();
		expect(source.getSnapshot()).not.toBe(initial);
		expect(flatChats(input).map(chat => chat.key)).toEqual(["/project/live.jsonl", "/project/middle.jsonl"]);
		expect(sidebarGroups(input)[0]?.chats.map(chat => chat.key)).toEqual(["/project/live.jsonl", "/project/middle.jsonl"]);
		expect(flatChats({ ...input, query: "Alpha" }).map(chat => chat.key)).toEqual(["/project/live.jsonl"]);
		expect(sidebarGroups({ ...input, query: "Alpha" })[0]?.chats.map(chat => chat.key)).toEqual(["/project/live.jsonl"]);
		expect(input.tabs).toBe(tabs);
		expect(input.sessionsByProject).toBe(sessionsByProject);
		const changed = source.getSnapshot();
		controller.emit("Alpha");
		expect(source.getSnapshot()).toBe(changed);
		expect(notify).toHaveBeenCalledOnce();
		stop();
		expect(controller.listeners.size).toBe(0);
		controller.emit("Later");
		expect(notify).toHaveBeenCalledOnce();
	});

	it("uses the same saved, tab, preview and unnamed fallbacks as displayed rows", () => {
		const tabs: ChatTab[] = [
			{ id: "saved", projectPath: "/project", sessionFile: "/project/saved.jsonl", title: "Stale tab" },
			{ id: "tab", projectPath: "/project", sessionFile: "/project/tab.jsonl", title: "Tab title" },
			{ id: "preview", projectPath: "/project", sessionFile: "/project/preview.jsonl", title: null },
			{ id: "untitled", projectPath: "/project", sessionFile: "/project/untitled.jsonl", title: null },
			{ id: "new", projectPath: "/project", sessionFile: null, title: null },
		];
		const sessions = { "/project": [saved("saved", "Saved title"), saved("tab", null), { ...saved("preview", null), preview: "First message" }, saved("untitled", null)] };
		const source = sidebarTitles(tabs, sessions, () => null, labels);
		expect([...source.getSnapshot()]).toEqual([
			["saved", "Saved title"], ["tab", "Tab title"], ["preview", "First message"], ["untitled", "Untitled chat"], ["new", "New chat"],
		]);
	});

	it("catches a title changed before subscription attaches", () => {
		const controller = liveController("Before");
		const source = sidebarTitles([{ id: "new", projectPath: "/project", sessionFile: null, title: null }], {}, () => controller, labels);
		controller.emit("After");
		const notify = vi.fn();
		const stop = source.subscribe(notify);
		expect(source.getSnapshot().get("new")).toBe("After");
		expect(notify).toHaveBeenCalledOnce();
		stop();
	});
});
