import type { ProjectSummary, SessionSummary } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { archivedChats, openChatOrder, type SidebarInput, sidebarGroups, visibleChats } from "./sidebarRows";

const project = (path: string, lastActivity: number): ProjectSummary => ({ path, name: path, sessionCount: 0, lastActivity, exists: true });
const session = (cwd: string, id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
	id,
	file: `${cwd}/${id}.jsonl`,
	cwd,
	title: id,
	createdAt: updatedAt,
	updatedAt,
	parentSession: null,
	preview: null,
	archived: false,
	...extra,
});

function input(patch: Partial<SidebarInput> = {}): SidebarInput {
	return {
		projects: [project("a", 1), project("b", 2)],
		sessionsByProject: {
			a: [session("a", "a1", 10), session("a", "a2", 20), session("a", "old", 1, { archived: true })],
			b: [session("b", "b1", 5)],
		},
		tabs: [
			{ id: "tNew", projectPath: "a", sessionFile: null },
			{ id: "tA1", projectPath: "a", sessionFile: "a/a1.jsonl" },
			{ id: "tB1", projectPath: "b", sessionFile: "b/b1.jsonl" },
		],
		pinnedProjects: ["a"],
		pinnedSessions: [],
		expanded: ["a", "b"],
		showAll: [],
		query: "",
		active: null,
		openTitle: () => null,
		...patch,
	};
}

describe("sidebarGroups", () => {
	it("lists pinned projects first and a new chat at the top of its project", () => {
		const groups = sidebarGroups(input());
		expect(groups.map(group => group.project.path)).toEqual(["a", "b"]);
		expect(groups[0]?.chats.map(chat => chat.key)).toEqual(["open:tNew", "a/a2.jsonl", "a/a1.jsonl"]);
		expect(groups[0]?.chats[2]?.tabId).toBe("tA1");
	});

	it("numbers only rows in expanded projects, in sidebar order", () => {
		const rows = visibleChats(sidebarGroups(input({ expanded: ["b"] })));
		expect(rows.map(chat => chat.key)).toEqual(["b/b1.jsonl"]);
	});

	it("keeps only accepted open chats under the Active filter and opens their projects", () => {
		const groups = sidebarGroups(input({ expanded: [], active: tabId => tabId === "tB1" }));
		expect(groups.map(group => [group.project.path, group.open, group.chats.map(chat => chat.key)])).toEqual([["b", true, ["b/b1.jsonl"]]]);
	});

	it("keeps archived chats out of project lists", () => {
		expect(visibleChats(sidebarGroups(input())).some(chat => chat.key === "a/old.jsonl")).toBe(false);
		expect(archivedChats(input()).map(chat => chat.key)).toEqual(["a/old.jsonl"]);
	});

	it("keeps a removed project's open chats in an open group until they close", () => {
		const removed = input({ projects: [project("b", 2)], expanded: [] });
		const group = sidebarGroups(removed).find(entry => entry.project.path === "a");
		expect(group).toMatchObject({ removed: true, open: true, project: { name: "a" } });
		expect(group?.chats.map(chat => chat.key)).toEqual(["open:tNew", "a/a1.jsonl"]);
		expect(openChatOrder(removed)).toEqual(["tB1", "tNew", "tA1"]);
		const closed = sidebarGroups({ ...removed, tabs: removed.tabs.filter(tab => tab.projectPath !== "a") });
		expect(closed.map(entry => entry.project.path)).toEqual(["b"]);
	});
});

describe("openChatOrder", () => {
	it("orders open chats as the sidebar lists them, collapsed projects included", () => {
		expect(openChatOrder(input({ expanded: [] }))).toEqual(["tNew", "tA1", "tB1"]);
	});
});
