import type { SessionSummary } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import type { GuestSnapshot } from "../../collab/lib/client";
import type { ChatTab } from "../../state/app";
import type { SessionView } from "../../state/session";
import { boardGroup, projectBoard, recentFold, WaitingTracker } from "./boardModel";

const path = "/project";
const tab = (id: string, sessionFile: string | null = `${id}.jsonl`): ChatTab => ({ id, sessionFile, projectPath: path, title: id });
const saved = (file: string, createdAt = 100, patch: Partial<SessionSummary> = {}): SessionSummary => ({ file, cwd: path, title: file, preview: null, createdAt, updatedAt: createdAt, archived: false, ...patch }) as SessionSummary;
const view = (patch: Partial<SessionView> = {}): SessionView => ({ mode: "live", working: false, workingSince: null, guest: null, error: null, ...patch }) as SessionView;
const question = { uiRequest: { title: "Approve the plan?", reqId: "q" } } as unknown as GuestSnapshot;
const keys = (rows: { key: string }[]) => rows.map(row => row.key);

describe("project board membership", () => {
	it("uses the first attention match, including errors and both unseen reasons", () => {
		for (const unseen of [undefined, "finished", "needsInput"] as const) {
			expect(boardGroup("needsInput", unseen)).toBe("waiting");
			expect(boardGroup("error", unseen)).toBe("waiting");
			expect(boardGroup("working", unseen)).toBe("working");
			expect(boardGroup("helpersWorking", unseen)).toBe("working");
			for (const status of ["idle", "live"] as const) expect(boardGroup(status, unseen)).toBe(unseen ? "unseen" : "recent");
		}
	});

	it("puts questions before errors or work and local errors before work", () => {
		const tabs = [tab("question"), tab("error"), tab("blocked"), tab("osc-error")];
		const views = new Map([
			["question", view({ guest: question, working: true, error: "failed" })],
			["error", view({ working: true, error: "failed" })],
			["blocked", view({ host: { programStatus: { state: "blocked", msg: "Grant permission" } } as SessionView["host"], working: true })],
			["osc-error", view({ host: { programStatus: { state: "error", msg: "Provider failed" } } as SessionView["host"], working: true })],
		]);
		const groups = projectBoard(path, tabs, [], { question: "finished", error: "needsInput" }, views);
		expect(keys(groups.waiting)).toEqual(tabs.map(tab => tab.id));
		expect(groups.waiting[0].status).toBe("needsInput");
		expect(groups.waiting[1].status).toBe("error");
		expect(groups.working).toEqual([]);
		expect(groups.unseen).toEqual([]);
	});

	it("unions unsaved and saved chats once, including continuation files, excluding other projects and archived history", () => {
		const tabs = [tab("new", null), tab("continued", "old.jsonl"), { ...tab("elsewhere"), projectPath: "/other" }];
		const groups = projectBoard(path, tabs, [saved("new-file.jsonl", 100, { previousSessionFiles: ["old.jsonl"] }), saved("closed.jsonl"), saved("archived.jsonl", 100, { archived: true })], {}, new Map());
		expect(keys(groups.recent)).toEqual(["new", "closed.jsonl", "new-file.jsonl"]);
		expect(groups.recent.find(row => row.key === "new-file.jsonl")?.tab?.id).toBe("continued");
	});

	it("shows open-only tabs before sessions load and retains a tab whose file is not indexed", () => {
		const tabs = [tab("unsaved", null), tab("not-indexed")];
		const groups = projectBoard(path, tabs, undefined, {}, new Map([["unsaved", view({ working: true })]]));
		expect(keys(groups.working)).toEqual(["unsaved"]);
		expect(keys(groups.recent)).toEqual(["not-indexed"]);
	});
});

describe("project board ordering and transitions", () => {
	it("keeps open order ahead of saved start order, with ascending file ties", () => {
		const tabs = [tab("first", null), tab("second", null)];
		const sessions = [saved("z", 100), saved("newest", 200), saved("a", 100)];
		const groups = projectBoard(path, tabs, sessions, {}, new Map());
		expect(keys(groups.recent)).toEqual(["first", "second", "newest", "a", "z"]);
	});

	it("does not reshuffle while updated times, titles, activity and elapsed bases stream", () => {
		const tabs = [tab("older", "older"), tab("newer", "newer")];
		const sessions = [saved("older", 100), saved("newer", 200)];
		const views = new Map(tabs.map(tab => [tab.id, view({ working: true })]));
		expect(keys(projectBoard(path, tabs, sessions, {}, views).working)).toEqual(["newer", "older"]);
		views.set("older", view({ working: true, workingSince: 1000 }));
		expect(keys(projectBoard(path, tabs, sessions.map(session => ({ ...session, updatedAt: session.file === "older" ? 99999 : 200, title: "streamed title" })), {}, views).working)).toEqual(["newer", "older"]);
	});

	it("moves only as waiting, work and unopened state change, keeping the badge after a question clears", () => {
		const tabs = [tab("chat")];
		const sessions = [saved("chat.jsonl")];
		const views = new Map([["chat", view({ working: true })]]);
		const at = (unseen: { chat?: "finished" | "needsInput" } = {}) => projectBoard(path, tabs, sessions, unseen, views);
		expect(keys(at().working)).toEqual(["chat.jsonl"]);
		views.set("chat", view({ guest: question, working: true }));
		expect(keys(at({ chat: "needsInput" }).waiting)).toEqual(["chat.jsonl"]);
		views.set("chat", view());
		expect(keys(at({ chat: "needsInput" }).unseen)).toEqual(["chat.jsonl"]);
		expect(keys(at().recent)).toEqual(["chat.jsonl"]);
		views.set("chat", view({ working: true }));
		expect(keys(at({ chat: "finished" }).working)).toEqual(["chat.jsonl"]);
	});

	it("caps only Recent and shows or folds all remaining rows", () => {
		const sessions = Array.from({ length: 13 }, (_, index) => saved(`${index}`, index));
		const recent = projectBoard(path, [], sessions, {}, new Map()).recent;
		const folded = recentFold(recent, false);
		expect(folded.first).toHaveLength(5);
		expect(folded.rest).toHaveLength(0);
		expect(folded.hidden).toBe(8);
		expect([...recentFold(recent, true).first, ...recentFold(recent, true).rest]).toEqual(recent);
		const tabs = sessions.map(session => tab(session.file, session.file));
		const views = new Map(tabs.map(tab => [tab.id, view({ working: true })]));
		const groups = projectBoard(path, tabs, sessions, {}, views);
		expect(groups.working).toHaveLength(13);
		for (const tab of tabs) views.set(tab.id, view({ guest: question }));
		expect(projectBoard(path, tabs, sessions, {}, views).waiting).toHaveLength(13);
		const unseen = Object.fromEntries(tabs.map(tab => [tab.id, "finished" as const]));
		expect(projectBoard(path, tabs, sessions, unseen, new Map()).unseen).toHaveLength(13);
	});
});

describe("waiting announcements", () => {
	it("silences first observations, announces once per episode and never repeats streaming title changes", () => {
		const tracker = new WaitingTracker();
		const tabs = [tab("chat", null)];
		const groups = (waiting: boolean) => projectBoard(path, tabs, [], {}, new Map([["chat", view(waiting ? { guest: question } : {})]]));
		expect(tracker.update(groups(true))).toEqual([]);
		expect(tracker.update(groups(false))).toEqual([]);
		expect(tracker.update(groups(true))).toHaveLength(1);
		tabs[0] = { ...tabs[0], title: "Changed title" };
		expect(tracker.update(groups(true))).toEqual([]);
		tracker.update(groups(false));
		expect(tracker.update(groups(true))).toHaveLength(1);
	});

	it("preserves the waiting episode when an unsaved tab acquires a saved file, and silences loaded history", () => {
		const tracker = new WaitingTracker();
		const tabs = [tab("chat", null)];
		const views = new Map([["chat", view()]]);
		tracker.update(projectBoard(path, tabs, undefined, {}, views));
		views.set("chat", view({ guest: question }));
		expect(tracker.update(projectBoard(path, tabs, undefined, {}, views))).toHaveLength(1);
		tabs[0] = tab("chat");
		expect(tracker.update(projectBoard(path, tabs, [saved("chat.jsonl")], {}, views))).toEqual([]);
		tabs.push(tab("loaded"));
		views.set("loaded", view({ guest: question }));
		expect(tracker.update(projectBoard(path, tabs, [saved("chat.jsonl"), saved("loaded.jsonl")], {}, views))).toEqual([]);
		expect(tracker.update(projectBoard(path, tabs, [], {}, views))).toEqual([]);
	});
});
