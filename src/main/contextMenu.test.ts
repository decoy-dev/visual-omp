import { describe, expect, it } from "vitest";
import { buildTextContextMenu, type TextContext } from "./contextMenu";

const context: TextContext = {
	isEditable: true,
	selectionText: "",
	misspelledWord: "",
	dictionarySuggestions: [],
	editFlags: {
		canUndo: true,
		canRedo: true,
		canCut: true,
		canCopy: true,
		canPaste: true,
		canDelete: true,
		canSelectAll: true,
		canEditRichly: false,
	},
};

describe("native text context menu", () => {
	it("offers spelling replacements and dictionary addition before editable actions", () => {
		const items = buildTextContextMenu({ ...context, misspelledWord: "teh", dictionarySuggestions: ["the", "ten"] }, "darwin");
		expect(items.slice(0, 4)).toEqual([
			{ label: "the", action: { kind: "replaceMisspelling", word: "the" } },
			{ label: "ten", action: { kind: "replaceMisspelling", word: "ten" } },
			{ label: "Add to dictionary", action: { kind: "addToDictionary", word: "teh" } },
			{ type: "separator" },
		]);
		expect(items[4]).toEqual({ role: "undo", enabled: true });
	});

	it("offers dictionary addition when no replacements are available", () => {
		expect(buildTextContextMenu({ ...context, misspelledWord: "vomp" }, "win32")[0]).toEqual({
			label: "Add to dictionary", action: { kind: "addToDictionary", word: "vomp" },
		});
	});

	it("offers standard editing roles without spelling items for an ordinary field", () => {
		expect(buildTextContextMenu(context, "darwin").flatMap(item => item.role ? [item.role] : [])).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
		expect(buildTextContextMenu(context, "win32")[0]?.role).toBe("undo");
	});

	it("adds no spelling items when no word is flagged", () => {
		expect(buildTextContextMenu({ ...context, dictionarySuggestions: ["the"] }, "darwin").some(item => item.action)).toBe(false);
	});

	it("adds paste and match style only for rich editing", () => {
		expect(buildTextContextMenu({ ...context, editFlags: { ...context.editFlags, canEditRichly: true } }, "darwin").flatMap(item => item.role ? [item.role] : [])).toEqual([
			"undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll",
		]);
	});

	it.each([true, false])("offers Windows Delete after Paste with canDelete=%s", canDelete => {
		const items = buildTextContextMenu({ ...context, editFlags: { ...context.editFlags, canDelete } }, "win32");
		const paste = items.findIndex(item => item.role === "paste");
		expect(items[paste + 1]).toEqual({ role: "delete", enabled: canDelete });
		expect(items[paste + 2]).toEqual({ type: "separator" });
		expect(items[paste + 3]?.role).toBe("selectAll");
		expect(buildTextContextMenu(context, "darwin").some(item => item.role === "delete")).toBe(false);
	});

	it("uses supplied locale strings for custom labels", () => {
		const labels = { addToDictionary: "Ajouter au dictionnaire", lookUp: "Rechercher « {{selection}} »" };
		expect(buildTextContextMenu({ ...context, misspelledWord: "vomp" }, "darwin", labels)[0]?.label).toBe(labels.addToDictionary);
		const items = buildTextContextMenu({ ...context, isEditable: false, selectionText: "$& example" }, "darwin", labels);
		expect(items.at(-1)?.label).toBe("Rechercher « $& example »");
	});

	it.each(["darwin", "win32"] as const)("honors each edit flag on %s", platform => {
		for (const [role, flag] of [
			["undo", "canUndo"], ["redo", "canRedo"], ["cut", "canCut"], ["copy", "canCopy"],
			["paste", "canPaste"], ["pasteAndMatchStyle", "canPaste"], ["selectAll", "canSelectAll"],
		] as const) {
			const items = buildTextContextMenu({ ...context, editFlags: { ...context.editFlags, canEditRichly: true, [flag]: false } }, platform);
			expect(items.find(item => item.role === role)?.enabled).toBe(false);
		}
	});

	it.each(["darwin", "win32"] as const)("offers read-only selection actions on %s", platform => {
		const items = buildTextContextMenu({ ...context, isEditable: false, selectionText: "hello & world?" }, platform);
		expect(items).toEqual(platform === "darwin" ? [
			{ role: "copy", enabled: true },
			{ type: "separator" },
			{ label: "Look up “hello & world?”", action: { kind: "lookUp" } },
		] : [{ role: "copy", enabled: true }]);
	});

	it("disables read-only Copy when Chromium disallows it", () => {
		const items = buildTextContextMenu({ ...context, isEditable: false, selectionText: "hello", editFlags: { ...context.editFlags, canCopy: false } }, "win32");
		expect(items[0]?.enabled).toBe(false);
	});

	it("opens no menu when nothing is selected outside an editable field", () => {
		expect(buildTextContextMenu({ ...context, isEditable: false }, "darwin")).toEqual([]);
	});

	it("keeps whitespace available to Copy without an empty lookup", () => {
		expect(buildTextContextMenu({ ...context, isEditable: false, selectionText: " \n " }, "darwin")).toEqual([{ role: "copy", enabled: true }]);
	});

	it("bounds lookup previews without splitting supplementary Unicode characters", () => {
		const letter = "\u{10400}";
		const selectionText = `${"a".repeat(38)}${letter} more text`;
		const items = buildTextContextMenu({ ...context, isEditable: false, selectionText }, "darwin");
		expect(items.at(-1)?.label).toBe(`Look up “${"a".repeat(38)}${letter}…”`);
		const shortSelection = `${"a".repeat(39)}${letter}`;
		const shortItems = buildTextContextMenu({ ...context, isEditable: false, selectionText: shortSelection }, "darwin");
		expect(shortItems.at(-1)?.label).toBe(`Look up “${shortSelection}”`);
	});

	it("normalizes multiline lookup previews", () => {
		const items = buildTextContextMenu({ ...context, isEditable: false, selectionText: "  first\n\tsecond   third " }, "darwin");
		expect(items.at(-1)?.label).toBe("Look up “first second third”");
	});
});
