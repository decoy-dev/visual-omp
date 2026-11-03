import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { attachClassicImages, classicImageFailure } from "./classic-image-paste";
import type { EditorDraftResult } from "@shared/contracts/composer";
const recorded = JSON.parse(readFileSync(new URL("./fixtures/18.15.0/classic-image-success.json", import.meta.url), "utf8"));
const imageSymbol: string = recorded.cases[0].editorReads[0].imageSymbol;

function fixture(original = "") {
	let editor: EditorDraftResult = { text: original, cleared: original === "", imageChips: 0, imageSymbol };
	let status: string | null = null;
	const input = {
		assertCurrent: vi.fn(),
		readEditor: vi.fn(async () => ({ ...editor })),
		restoreEditor: vi.fn(async (expected: string, text: string) => {
			if (editor.text !== expected) return { ...editor, restored: false };
			editor = { text, cleared: text === "", imageChips: 0 };
			return { ...editor, restored: true };
		}),
		failureText: vi.fn(async () => status),
		paste: vi.fn((_text: string) => {}),
		wait: vi.fn(async () => {}),
	};
	return { input, editor: () => editor, setEditor: (value: EditorDraftResult) => { editor = { imageSymbol, ...value }; }, fail: (text = "Failed to read pasted image path") => { status = text; } };
}

describe("classic image attachment acknowledgement", () => {
	it.each(["", "original draft "])("restores an exact text-only failure with baseline %j", async original => {
		const f = fixture(original);
		f.input.paste.mockImplementation(() => { f.setEditor({ text: `${original}/tmp/Screen Shot.png`, cleared: false, imageChips: 0 }); f.fail(); });
		await expect(attachClassicImages("/tmp/Screen\\ Shot.png", f.input)).rejects.toThrow("Image submission was restored. Failed to read pasted image path");
		expect(f.editor().text).toBe(original);
		expect(f.input.restoreEditor).toHaveBeenCalledExactlyOnceWith(`${original}/tmp/Screen Shot.png`, original);
	});
	it("leaves mixed successful and failed attachments in required recovery", async () => {
		const f = fixture();
		f.input.paste.mockImplementation(path => {
			if (path === "/tmp/good.png") f.setEditor({ text: `${imageSymbol} #1 `, cleared: false, imageChips: 1 });
			else { f.setEditor({ text: `${imageSymbol} #1 /tmp/bad.png`, cleared: false, imageChips: 1 }); f.fail(); }
		});
		await expect(attachClassicImages("/tmp/good.png /tmp/bad.png /tmp/never.png", f.input)).rejects.toThrow("Image submission needs recovery. Failed to read pasted image path");
		expect(f.input.paste).toHaveBeenCalledTimes(2);
		expect(f.input.restoreEditor).not.toHaveBeenCalled();
	});
	it("does not overwrite unrelated editor changes or a rejected guarded restore", async () => {
		for (const changed of [false, true]) {
			const f = fixture("original ");
			f.input.paste.mockImplementation(() => { f.setEditor({ text: changed ? "newer unrelated text" : "original /tmp/bad.png", cleared: false, imageChips: 0 }); f.fail(); });
			if (!changed) f.input.restoreEditor.mockResolvedValue({ text: "newer text", cleared: false, restored: false });
			await expect(attachClassicImages("/tmp/bad.png", f.input)).rejects.toThrow("Image submission needs recovery.");
			if (changed) expect(f.input.restoreEditor).not.toHaveBeenCalled();
		}
	});
	it("rejects a chip count mismatch and an acknowledgement timeout without submitting", async () => {
		const now = vi.spyOn(Date, "now");
		try {
			for (const count of [0, 2]) {
				const f = fixture();
				f.input.paste.mockImplementation(() => { f.setEditor({ text: "unexpected", cleared: false, imageChips: count }); });
				now.mockReturnValueOnce(0).mockReturnValue(9000);
				await expect(attachClassicImages("/tmp/bad.png", f.input)).rejects.toThrow("Image submission needs recovery. omp did not confirm the image attachment.");
				expect(f.input.restoreEditor).not.toHaveBeenCalled();
			}
		} finally { now.mockRestore(); }
	});
	it("does not acknowledge a failed path whose filename resembles an image token", async () => {
		const f = fixture();
		f.input.paste.mockImplementation(() => { f.setEditor({ text: `/tmp/${imageSymbol} #1.png`, cleared: false, imageChips: 1 }); f.fail(); });
		await expect(attachClassicImages(`/tmp/${imageSymbol}\\ #1.png`, f.input)).rejects.toThrow("Image submission needs recovery. omp's editor changed while attaching the image.");
		expect(f.input.restoreEditor).not.toHaveBeenCalled();
	});
	it("does not treat an unchanged earlier failure status as a new paste failure", async () => {
		const f = fixture();
		f.fail();
		f.input.wait.mockImplementation(async () => { f.setEditor({ text: `${imageSymbol} #1 `, cleared: false, imageChips: 1 }); });
		await attachClassicImages("/tmp/good.png", f.input);
		expect(f.input.wait).toHaveBeenCalledOnce();
		expect(f.input.restoreEditor).not.toHaveBeenCalled();
	});
	it("fails closed when the session changes after the image paste", async () => {
		const f = fixture();
		f.input.paste.mockImplementation(() => { f.input.assertCurrent.mockImplementation(() => { throw new Error("The chat changed."); }); });
		await expect(attachClassicImages("/tmp/bad.png", f.input)).rejects.toThrow("Image submission needs recovery. The chat changed.");
		expect(f.input.restoreEditor).not.toHaveBeenCalled();
	});
	it("refuses unavailable exact state before writing any paste", async () => {
		const f = fixture();
		f.setEditor({ text: "", cleared: true });
		await expect(attachClassicImages("/tmp/bad.png", f.input)).rejects.toThrow("omp did not report its image attachments.");
		expect(f.input.paste).not.toHaveBeenCalled();
	});
	it("reads omp's diagnostic while excluding editor and unrelated text components", () => {
		expect(classicImageFailure({ editor: { textPreview: "Failed to read pasted image path", cursorLine: 0 } })).toBeNull();
		expect(classicImageFailure({ transcript: { textPreview: "hello" }, status: { textPreview: "Failed to read pasted image path" } })).toBe("Failed to read pasted image path");
	});
});
