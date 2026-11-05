import { beforeEach, describe, expect, it } from "vitest";
import { officeSnapshotBytes, useLivePreview } from "./store";
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
