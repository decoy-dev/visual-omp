import { beforeEach, describe, expect, it } from "vitest";
import { followedSubject, officeSnapshotBytes, useLivePreview } from "./store";
import type { DocxFrameSnapshot, LiveFormat, LiveSubject, XlsxFrameSnapshot } from "./types";
const subject = (id: string, path = `/project/${id}.docx`, format: LiveFormat = "docx", revision = 3) => ({ id, kind: "file", format, path, revision } as LiveSubject);
const snapshot = (path = "/project/office.docx", revision = 3, body = "<p>Safe presentation</p>"): DocxFrameSnapshot => ({ path, revision, format: "docx", body, styles: "<style>p{color:red}</style>" });
beforeEach(() => useLivePreview.setState({ chats: {} }));
describe("retained Office presentations", () => {
	it("keeps the latest complete presentation across selection and refuses stale writes", () => {
		const state = useLivePreview.getState(); state.update("chat", [subject("office"), subject("bomb")], []);
		const safe = snapshot(); state.retainOffice("chat", "office", safe);
		state.select("chat", "bomb"); state.select("chat", "office");
		expect(state.readOffice("chat", "office", safe.path, "docx", 3)).toBe(safe);
		state.retainOffice("chat", "office", snapshot(safe.path, 2));
		expect(state.readOffice("chat", "office", safe.path, "docx", 3)).toBe(safe);
		expect("bytes" in safe).toBe(false);
	});
	it("checks path and format on reads and writes and invalidates same-ID file reuse", () => {
		const state = useLivePreview.getState(); state.update("chat", [subject("office")], []);
		state.retainOffice("chat", "office", snapshot());
		expect(state.readOffice("chat", "office", "/project/other.docx", "docx", 3)).toBeNull();
		expect(state.readOffice("chat", "office", "/project/office.docx", "xlsx", 3)).toBeNull();
		state.retainOffice("chat", "office", snapshot("/project/other.docx"));
		expect(useLivePreview.getState().chats.chat!.officeFrames.office?.path).toBe("/project/office.docx");
		state.update("chat", [subject("office", "/project/other.docx")], []);
		expect(useLivePreview.getState().chats.chat!.officeFrames).toEqual({});
		state.retainOffice("chat", "office", snapshot("/project/other.docx"));
		state.update("chat", [subject("office", "/project/other.docx", "xlsx")], []);
		expect(useLivePreview.getState().chats.chat!.officeFrames).toEqual({});
	});
	it("never restores a future revision and retains the newer success through a later incomplete revision", () => {
		const state = useLivePreview.getState(); state.update("chat", [subject("office", undefined, "docx", 5)], []);
		const newest = snapshot(undefined, 5, "<p>Revision five</p>"); state.retainOffice("chat", "office", newest);
		expect(state.readOffice("chat", "office", newest.path, "docx", 4)).toBeNull();
		state.update("chat", [subject("office", undefined, "docx", 6)], []); state.select("chat", "office");
		expect(state.readOffice("chat", "office", newest.path, "docx", 6)).toBe(newest);
		state.update("chat", [subject("office", undefined, "docx", 2)], []);
		expect(useLivePreview.getState().chats.chat!.officeFrames).toEqual({});
	});
	it("clears presentation on authorization loss, stage close, chat close and retirement", () => {
		const state = useLivePreview.getState(); state.update("chat", [subject("office")], []);
		state.retainOffice("chat", "office", snapshot()); state.discardOffice("chat", "office", "/project/office.docx", "docx");
		expect(state.readOffice("chat", "office", "/project/office.docx", "docx", 3)).toBeNull();
		state.retainOffice("chat", "office", snapshot()); state.update("chat", [subject("other")], []);
		expect(useLivePreview.getState().chats.chat!.officeFrames).toEqual({});
		state.retainOffice("chat", "other", snapshot("/project/other.docx")); state.close("chat");
		expect(useLivePreview.getState().chats.chat!.officeFrames).toEqual({});
		state.forget("chat"); expect(useLivePreview.getState().chats.chat).toBeUndefined();
	});
	it("accounts for UTF-16 presentations and bounds retained state to 32 MiB", () => {
		const state = useLivePreview.getState(); state.update("chat", [subject("old"), subject("new")], []);
		const old = snapshot("/project/old.docx", 3, "x".repeat(10 * 1024 * 1024));
		expect(officeSnapshotBytes(old)).toBeGreaterThan(20 * 1024 * 1024);
		state.retainOffice("chat", "old", old);
		state.retainOffice("chat", "new", snapshot("/project/new.docx", 3, "y".repeat(10 * 1024 * 1024)));
		expect(Object.keys(useLivePreview.getState().chats.chat!.officeFrames)).toEqual(["new"]);
	});
	it("retains only a bounded XLSX text window", () => {
		const state = useLivePreview.getState(); state.update("chat", [subject("sheet", "/project/sheet.xlsx", "xlsx")], []);
		const text: XlsxFrameSnapshot = { format: "xlsx", path: "/project/sheet.xlsx", revision: 3, sheets: [{ name: "Sheet", rows: 50000, cols: 2, limited: false }], window: { sheet: 0, rowStart: 49999, rowEnd: 50000, colStart: 0, colEnd: 2, cells: [["50000", "<img src=x>"]] } };
		state.retainOffice("chat", "sheet", text);
		expect(state.readOffice("chat", "sheet", text.path, "xlsx", 3)).toBe(text);
		state.retainOffice("chat", "sheet", { ...text, window: { ...text.window, cells: [["x".repeat(1001)]] } });
		expect(state.readOffice("chat", "sheet", text.path, "xlsx", 3)).toBe(text);
		expect("bytes" in text).toBe(false);
	});
});

it("rejects a different snapshot format on write without replacing the authorized presentation", () => {
	const state = useLivePreview.getState(); state.update("chat", [subject("office")], []);
	const safe = snapshot(); state.retainOffice("chat", "office", safe);
	state.retainOffice("chat", "office", { format: "xlsx", path: safe.path, revision: 3, sheets: [{ name: "Other", rows: 1, cols: 1, limited: false }], window: { sheet: 0, rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1, cells: [["Wrong format"]] } });
	expect(state.readOffice("chat", "office", safe.path, "docx", 3)).toBe(safe);
});

it("invalidates superseded content when a newer successful presentation is oversized, including after reselection and a late old write", () => {
	const state = useLivePreview.getState(), first = snapshot(undefined, 1, "<p>Revision one</p>");
	state.update("chat", [subject("office", undefined, "docx", 1), subject("bomb")], []);
	state.retainOffice("chat", "office", first);
	expect(state.readOffice("chat", "office", first.path, "docx", 1)).toBe(first);
	state.update("chat", [subject("office", undefined, "docx", 2), subject("bomb")], []);
	const oversized = snapshot(undefined, 2, "x".repeat(16 * 1024 * 1024));
	expect(officeSnapshotBytes(oversized)).toBeGreaterThan(32 * 1024 * 1024);
	state.retainOffice("chat", "office", oversized);
	expect(useLivePreview.getState().chats.chat!.officeFrames.office).toBeUndefined();
	expect(useLivePreview.getState().chats.chat!.officeHeads.office).toEqual({ path: first.path, format: "docx", revision: 2 });
	state.update("chat", [subject("office", undefined, "docx", 3), subject("bomb")], []);
	state.select("chat", "bomb"); state.select("chat", "office");
	expect(state.readOffice("chat", "office", first.path, "docx", 3)).toBeNull();
	state.retainOffice("chat", "office", first);
	expect(state.readOffice("chat", "office", first.path, "docx", 3)).toBeNull();
	expect(useLivePreview.getState().chats.chat!.officeHeads.office?.revision).toBe(2);
});

describe("automatic Office following", () => {
	it.each(["docx", "xlsx", "pptx"] as const)("keeps the accepted %s visible and permits explicit selection of a refused file", format => {
		const state = useLivePreview.getState();
		const good = subject("office", `/project/office.${format}`, format);
		const bomb = subject("bomb", `/project/bomb.${format}`, format);
		state.update("chat", [good], []); state.checkOffice("chat", good, true);
		state.update("chat", [bomb, good], []);
		expect(followedSubject(useLivePreview.getState().chats.chat!)?.id).toBe("office");
		state.checkOffice("chat", bomb, false);
		expect(followedSubject(useLivePreview.getState().chats.chat!)?.id).toBe("office");
		expect(useLivePreview.getState().chats.chat!.subjects).toContain(bomb);
		state.select("chat", "bomb");
		expect(followedSubject(useLivePreview.getState().chats.chat!)?.id).toBe("bomb");
	});
	it("follows a newly accepted candidate and rechecks a refused file after a new save", () => {
		const state = useLivePreview.getState(), old = subject("old"), next = subject("next");
		state.update("chat", [next, old], []); state.checkOffice("chat", old, true);
		state.checkOffice("chat", next, false);
		expect(followedSubject(useLivePreview.getState().chats.chat!)?.id).toBe("old");
		const saved = { ...next, revision: 4 };
		state.update("chat", [saved, old], []); state.checkOffice("chat", next, true);
		expect(followedSubject(useLivePreview.getState().chats.chat!)?.id).toBe("old");
		state.checkOffice("chat", saved, true);
		expect(followedSubject(useLivePreview.getState().chats.chat!)?.id).toBe("next");
	});
});

it("keeps deferred candidates selectable, skips them automatically, and invalidates deferral on a new revision", () => {
	const state = useLivePreview.getState(), a = subject("a"), b = subject("b"), c = subject("c");
	state.update("chat", [c, b, a], []); state.checkOffice("chat", a, true);
	state.checkOffice("chat", c, null); state.checkOffice("chat", b, true);
	expect(followedSubject(useLivePreview.getState().chats.chat!)?.id).toBe("b");
	state.select("chat", c.id);
	expect(followedSubject(useLivePreview.getState().chats.chat!)?.id).toBe("c");
	const next = { ...c, revision: c.revision + 1 };
	state.update("chat", [next, b, a], []);
	expect(useLivePreview.getState().chats.chat!.officeChecks.c).toBeUndefined();
	state.checkOffice("chat", c, null);
	expect(useLivePreview.getState().chats.chat!.officeChecks.c).toBeUndefined();
});
