import { describe, expect, it, vi } from "vitest";
import { exactEditorDraft } from "./native-editor";

const text = `Please inspect https://example.test/${"long_identifier_without_breaks_".repeat(6)}?a=one|two&b=日本語🧭 and keep literal | pipes intact.`;
const take = { operation: "take", sessionId: "session", expected: text } as const;

describe("exact trusted editor transfer", () => {
	it("transfers long URLs, literal pipes and Unicode without reconstructing painted rows", () => {
		let buffer = text;
		const ui = { getEditorText: () => buffer, setEditorText: vi.fn((value: string) => { buffer = value; }) };
		expect(text.length).toBeGreaterThan(120);
		expect(exactEditorDraft(ui, take, "session")).toEqual({ text, cleared: true });
		expect(buffer).toBe("");
		expect(ui.setEditorText).toHaveBeenCalledExactlyOnceWith("");
	});
	it("leaves the only TUI copy untouched if reading it fails", () => {
		const set = vi.fn();
		const result = exactEditorDraft({ getEditorText: () => { throw new Error("read failed"); }, setEditorText: set }, take, "session");
		expect(result).toMatchObject({ text: null, cleared: false });
		expect(set).not.toHaveBeenCalled();
	});
	it("preserves exact captured text when clearing fails before or after it changes the buffer", () => {
		for (const clearsFirst of [false, true]) {
			let buffer = text;
			const result = exactEditorDraft({ getEditorText: () => buffer, setEditorText: value => {
				if (value === "") { if (clearsFirst) buffer = ""; throw new Error("clear failed"); }
				buffer = value;
			} }, take, "session");
			expect(result).toMatchObject({ text, cleared: false });
			expect(buffer).toBe(text);
		}
	});
	it("restores the captured string after a failed clear verification, only while the editor is still empty", () => {
		let buffer = text, reads = 0;
		const result = exactEditorDraft({ getEditorText: () => { if (++reads === 2) throw new Error("verification failed"); return buffer; }, setEditorText: value => { buffer = value; } }, take, "session");
		expect(result).toMatchObject({ text, cleared: false });
		expect(buffer).toBe(text);
	});
	it("does not overwrite a newer editor value while recovering a failed clear", () => {
		let buffer = text;
		const set = vi.fn((_value: string) => { buffer = "Newer TUI input | 日本語"; });
		const result = exactEditorDraft({ getEditorText: () => buffer, setEditorText: set }, take, "session");
		expect(result).toMatchObject({ text, cleared: false });
		expect(buffer).toBe("Newer TUI input | 日本語");
		expect(set).toHaveBeenCalledOnce();
	});
	it("refuses another room or an unexpected draft without changing it", () => {
		const set = vi.fn();
		const ui = { getEditorText: () => "New room text", setEditorText: set };
		expect(exactEditorDraft(ui, take, "other")).toMatchObject({ text: null, cleared: false });
		expect(exactEditorDraft(ui, take, "session")).toMatchObject({ text: "New room text", cleared: false });
		expect(set).not.toHaveBeenCalled();
	});
	it("uses the same self-contained function embedded in the hosted extension", () => {
		const embedded = new Function(`return (${exactEditorDraft.toString()});`)() as typeof exactEditorDraft;
		let buffer = text;
		expect(embedded({ getEditorText: () => buffer, setEditorText: value => { buffer = value; } }, take, "session")).toEqual({ text, cleared: true });
	});
});
