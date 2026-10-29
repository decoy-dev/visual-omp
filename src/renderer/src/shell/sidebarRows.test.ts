import type { ProjectSummary, SessionSummary } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { archivedChats, currentChats, nextWaitingChat, type SidebarInput, sidebarGroups, stepChat } from "./sidebarRows";

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
		expect(rows.map(row => row.key)).toEqual(["open:tNew", "a/latest.jsonl", "a/other.jsonl"]);
		expect(rows[1]?.tabId).toBe("tA1");
		expect(currentChats(state).find(row => row.tabId === "tA1")).toMatchObject({ kind: "session", session: { id: "latest" } });
		expect(sidebarGroups({ ...state, query: "latest" })[0]?.chats).toHaveLength(1);
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
