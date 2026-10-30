import type { ProjectSummary, SessionSummary } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { archivedChats, currentChats, flatChats, nextWaitingChat, type SidebarInput, sidebarGroups, stepChat } from "./sidebarRows";

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
		expanded: ["a", "b"],
		showAll: [],
		query: "",
		untitledTitle: "Untitled chat",
		newChatTitle: "New chat",
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

	it("keeps archived chats out of project lists", () => {
		expect(sidebarGroups(input()).some(group => group.chats.some(chat => chat.key === "a/old.jsonl"))).toBe(false);
		expect(archivedChats(input()).map(chat => chat.key)).toEqual(["a/old.jsonl"]);
	});

	it("keeps a removed project's open chats in an open group until they close", () => {
		const removed = input({ projects: [project("b", 2)], expanded: [] });
		const group = sidebarGroups(removed).find(entry => entry.project.path === "a");
		expect(group).toMatchObject({ removed: true, open: true, project: { name: "a" } });
		expect(group?.chats.map(chat => chat.key)).toEqual(["open:tNew", "a/a1.jsonl"]);
		const closed = sidebarGroups({ ...removed, tabs: removed.tabs.filter(tab => tab.projectPath !== "a") });
		expect(closed.map(entry => entry.project.path)).toEqual(["b"]);
	});

	it("uses omp pins and folds an open predecessor into its newest saved copy", () => {
		const newest = session("a", "latest", 30, { pinned: true, previousSessionFiles: ["a/a1.jsonl"] });
		const state = input({ sessionsByProject: { a: [session("a", "other", 40), newest] } });
		const rows = sidebarGroups(state)[0]!.chats;
		expect(rows.map(row => row.key)).toEqual(["a/latest.jsonl", "open:tNew", "a/other.jsonl"]);
		expect(rows[0]?.tabId).toBe("tA1");
		expect(currentChats(state).find(row => row.tabId === "tA1")).toMatchObject({ kind: "session", session: { id: "latest" } });
		expect(sidebarGroups({ ...state, query: "latest" })[0]?.chats).toHaveLength(1);
	});
});

describe("Projects sorting", () => {
	const sortedInput = (patch: Partial<SidebarInput> = {}) => input({
		projects: [project("Project 10", 40), project("project 2", 30), project("Alpha", 10), project("Empty", 50)],
		sessionsByProject: {
			"Project 10": [
				session("Project 10", "Chat 10", 40, { createdAt: 10 }),
				session("Project 10", "chat 2", 20, { createdAt: 30 }),
				session("Project 10", "Pinned", 5, { pinned: true, createdAt: 50 }),
				session("Project 10", "Archived", 100, { archived: true, createdAt: 1 }),
			],
			"project 2": [session("project 2", "Beta", 30, { createdAt: 5 })],
			Alpha: [session("Alpha", "First", 10, { createdAt: 20 })],
		},
		tabs: [],
		pinnedProjects: [],
		expanded: [],
		...patch,
	});

	it("sorts grouped projects and chats by recent activity, with pins ahead of newer entries", () => {
		const groups = sidebarGroups(sortedInput({ pinnedProjects: ["Alpha"] }));
		expect(groups.map(group => group.project.name)).toEqual(["Alpha", "Empty", "Project 10", "project 2"]);
		expect(groups.find(group => group.project.name === "Project 10")?.chats.map(chat => chat.key))
			.toEqual(["Project 10/Pinned.jsonl", "Project 10/Chat 10.jsonl", "Project 10/chat 2.jsonl"]);
	});

	it("uses case-insensitive natural names for grouped projects and chats, with pins first", () => {
		const state = sortedInput({ sortBy: "name", pinnedProjects: ["project 2", "Project 10"] });
		const groups = sidebarGroups(state);
		expect(groups.map(group => group.project.name)).toEqual(["project 2", "Project 10", "Alpha", "Empty"]);
		expect(groups[1]?.chats.map(chat => chat.key))
			.toEqual(["Project 10/Pinned.jsonl", "Project 10/chat 2.jsonl", "Project 10/Chat 10.jsonl"]);
	});

	it("sorts created projects by earliest saved chat, including archived chats, then unknown dates", () => {
		const groups = sidebarGroups(sortedInput({ sortBy: "created" }));
		expect(groups.map(group => group.project.name)).toEqual(["Project 10", "project 2", "Alpha", "Empty"]);
		expect(groups[0]?.chats.map(chat => chat.key))
			.toEqual(["Project 10/Pinned.jsonl", "Project 10/Chat 10.jsonl", "Project 10/chat 2.jsonl"]);
	});

	it("sorts flat chats across projects, without applying project pins, disclosure or row limits", () => {
		const state = sortedInput({ pinnedProjects: ["Alpha"] });
		expect(flatChats(state).map(chat => [chat.key, chat.projectName, chat.projectPath])).toEqual([
			["Project 10/Pinned.jsonl", "Project 10", "Project 10"],
			["Project 10/Chat 10.jsonl", "Project 10", "Project 10"],
			["project 2/Beta.jsonl", "project 2", "project 2"],
			["Project 10/chat 2.jsonl", "Project 10", "Project 10"],
			["Alpha/First.jsonl", "Alpha", "Alpha"],
		]);
		const many = input({ tabs: [], sessionsByProject: { a: Array.from({ length: 12 }, (_, i) => session("a", String(i), i)) } });
		expect(sidebarGroups(many)[0]?.chats).toHaveLength(8);
		expect(flatChats(many)).toHaveLength(12);
	});

	it("sorts flat names and creation dates across project boundaries, with pins first", () => {
		expect(flatChats(sortedInput({ sortBy: "name" })).map(chat => chat.key)).toEqual([
			"Project 10/Pinned.jsonl", "project 2/Beta.jsonl", "Project 10/chat 2.jsonl", "Project 10/Chat 10.jsonl", "Alpha/First.jsonl",
		]);
		expect(flatChats(sortedInput({ sortBy: "created" })).map(chat => chat.key)).toEqual([
			"Project 10/Pinned.jsonl", "project 2/Beta.jsonl", "Project 10/Chat 10.jsonl", "Alpha/First.jsonl", "Project 10/chat 2.jsonl",
		]);
	});

	it.each(["recent", "name", "created"] as const)("keeps equal %s keys stable for projects and chats", sortBy => {
		const state = input({
			sortBy,
			tabs: [],
			pinnedProjects: [],
			projects: [{ ...project("b", 10), name: "same" }, { ...project("a", 10), name: "SAME" }],
			sessionsByProject: {
				b: [session("b", "second", 10, { title: "same" }), session("b", "first", 10, { title: "SAME" })],
				a: [session("a", "third", 10, { title: "Same" })],
			},
		});
		expect(sidebarGroups(state).map(group => group.project.path)).toEqual(["b", "a"]);
		expect(sidebarGroups(state)[0]?.chats.map(chat => chat.key)).toEqual(["b/second.jsonl", "b/first.jsonl"]);
		expect(flatChats(state).map(chat => chat.key)).toEqual(["b/second.jsonl", "b/first.jsonl", "a/third.jsonl"]);
	});

	it("keeps unsaved chats reachable and sorts their live titles without inventing creation dates", () => {
		const state = input({
			tabs: [
				{ id: "new10", projectPath: "a", sessionFile: null },
				{ id: "new2", projectPath: "a", sessionFile: null },
			],
			openTitle: id => id === "new10" ? "Chat 10" : "Chat 2",
			sessionsByProject: { a: [session("a", "pinned", 10, { pinned: true }), session("a", "saved", 20)] },
		});
		expect(flatChats(state).map(chat => chat.key)).toEqual(["a/pinned.jsonl", "open:new10", "open:new2", "a/saved.jsonl"]);
		expect(flatChats({ ...state, sortBy: "created" }).map(chat => chat.key)).toEqual(["a/pinned.jsonl", "a/saved.jsonl", "open:new10", "open:new2"]);
		expect(flatChats({ ...state, sortBy: "name" }).map(chat => chat.key)).toEqual(["a/pinned.jsonl", "open:new2", "open:new10", "a/saved.jsonl"]);
	});

	it("sorts unnamed chats by the labels displayed in their rows", () => {
		const state = input({
			sortBy: "name", pinnedProjects: [],
			tabs: [{ id: "new", projectPath: "a", sessionFile: null }],
			sessionsByProject: { a: [
				session("a", "z", 1, { title: "Zebra" }),
				session("a", "unnamed", 1, { title: null }),
				session("a", "a", 1, { title: "Alpha" }),
			] },
		});
		expect(flatChats(state).map(chat => chat.key)).toEqual(["a/a.jsonl", "open:new", "a/unnamed.jsonl", "a/z.jsonl"]);
	});

	it("uses saved creation dates for removed projects retained through their open chats", () => {
		const state = input({
			sortBy: "created", pinnedProjects: [],
			projects: [project("b", 2)],
			tabs: [{ id: "removed", projectPath: "a", sessionFile: "a/early.jsonl" }],
			sessionsByProject: { a: [session("a", "early", 1)], b: [session("b", "later", 2)] },
		});
		expect(sidebarGroups(state).map(group => [group.project.path, group.removed])).toEqual([["a", true], ["b", false]]);
	});

	it("searches saved previews, live titles and project names in both modes without restoring archived rows", () => {
		const state = sortedInput({ query: "project 10" });
		expect(sidebarGroups(state).map(group => [group.project.name, group.chats.length, group.open])).toEqual([["Project 10", 3, true]]);
		expect(flatChats(state)).toHaveLength(3);
		expect(flatChats({ ...state, query: "archived" })).toHaveLength(0);
		const live = input({ query: "checkout", openTitle: () => "Fix checkout" });
		expect(sidebarGroups(live)[0]?.chats.map(chat => chat.key)).toContain("open:tNew");
		expect(flatChats(live).map(chat => chat.key)).toContain("open:tNew");
		const preview = sortedInput({ sessionsByProject: { Alpha: [session("Alpha", "title", 1, { preview: "Find checkout" })] }, query: "checkout" });
		expect(sidebarGroups(preview)[0]?.chats[0]?.key).toBe("Alpha/title.jsonl");
		expect(flatChats(preview)[0]?.key).toBe("Alpha/title.jsonl");
	});

	it("leaves Current chats in opening order under every Projects sort", () => {
		for (const sortBy of ["recent", "name", "created"] as const) {
			expect(currentChats(input({ sortBy })).map(chat => chat.tabId)).toEqual(["tNew", "tA1", "tB1"]);
		}
	});
});

describe("currentChats", () => {
	it("lists every open chat in the order it was opened, collapsed and removed projects included, with its project name", () => {
		const rows = currentChats(input({ projects: [project("b", 2)], expanded: [] }));
		expect(rows.map(chat => [chat.tabId, chat.kind, chat.projectName])).toEqual([
			["tNew", "open", "a"],
			["tA1", "session", "a"],
			["tB1", "session", "b"],
		]);
	});

	it("keeps that order while the saved lists reorder", () => {
		const recent = input({ sessionsByProject: { a: [session("a", "a1", 99)], b: [session("b", "b1", 100)] } });
		expect(currentChats(recent).map(chat => chat.tabId)).toEqual(["tNew", "tA1", "tB1"]);
	});

	it("narrows to chats matching the search by saved title, live title or project name", () => {
		const rows = (query: string) => currentChats(input({ query, openTitle: tabId => (tabId === "tNew" ? "Fix checkout" : null) })).map(chat => chat.tabId);
		expect(rows("checkout")).toEqual(["tNew"]);
		expect(rows("a1")).toEqual(["tA1"]);
		expect(rows("b")).toEqual(["tB1"]);
	});
});

describe("stepChat", () => {
	const order = ["t1", "t2", "t3"];
	it("steps along the order and wraps both ways", () => {
		expect(stepChat(order, "t3", 1)).toBe("t1");
		expect(stepChat(order, "t1", -1)).toBe("t3");
		expect(stepChat(order, "t2", 1)).toBe("t3");
	});

	it("starts at the first chat when no open chat is focused", () => {
		expect(stepChat(order, null, 1)).toBe("t1");
		expect(stepChat([], null, 1)).toBeNull();
	});
});

describe("nextWaitingChat", () => {
	const order = ["t1", "t2", "t3", "t4"];
	it("picks the next waiting chat after the focused one, wrapping around", () => {
		expect(nextWaitingChat(order, "t2", id => id === "t4" || id === "t1")).toBe("t4");
		expect(nextWaitingChat(order, "t4", id => id === "t4" || id === "t1")).toBe("t1");
	});

	it("skips the focused chat and starts from the top without one", () => {
		expect(nextWaitingChat(order, "t3", id => id === "t3")).toBeNull();
		expect(nextWaitingChat(order, null, id => id === "t3" || id === "t2")).toBe("t2");
	});
});
