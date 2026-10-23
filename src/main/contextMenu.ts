import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import messages from "../shared/i18n/en/contextMenu.json";

export type TextContext = Pick<ContextMenuParams, "isEditable" | "selectionText" | "misspelledWord" | "dictionarySuggestions" | "editFlags">;

type TextAction =
	| { kind: "replaceMisspelling"; word: string }
	| { kind: "addToDictionary"; word: string }
	| { kind: "lookUp" };

export type TextMenuItem = MenuItemConstructorOptions & { action?: TextAction };

/** Pure menu rules; index.ts binds custom actions to the window that received the event. */
export function buildTextContextMenu(params: TextContext, platform: NodeJS.Platform, labels = messages): TextMenuItem[] {
	const { editFlags: flags } = params;
	if (params.isEditable) {
		const items: TextMenuItem[] = [];
		// Chromium names a misspelled word only when the spellchecker flagged it. `spellcheckEnabled` is no guide: Electron
		// reports it false on macOS even for a field it checks, with the word and its suggestions present.
		if (params.misspelledWord) {
			for (const word of params.dictionarySuggestions) {
				items.push({ label: word, action: { kind: "replaceMisspelling", word } });
			}
			items.push(
				{ label: labels.addToDictionary, action: { kind: "addToDictionary", word: params.misspelledWord } },
				{ type: "separator" },
			);
		}
		items.push(
			{ role: "undo", enabled: flags.canUndo },
			{ role: "redo", enabled: flags.canRedo },
			{ type: "separator" },
			{ role: "cut", enabled: flags.canCut },
			{ role: "copy", enabled: flags.canCopy },
			{ role: "paste", enabled: flags.canPaste },
		);
		// Plain inputs already paste unformatted text, so the second paste action adds nothing there.
		if (flags.canEditRichly) items.push({ role: "pasteAndMatchStyle", enabled: flags.canPaste });
		if (platform === "win32") items.push({ role: "delete", enabled: flags.canDelete });
		items.push({ type: "separator" }, { role: "selectAll", enabled: flags.canSelectAll });
		return items;
	}

	if (!params.selectionText) return [];
	const items: TextMenuItem[] = [{ role: "copy", enabled: flags.canCopy }];
	if (platform !== "darwin") return items;
	const selection = params.selectionText.trim().replace(/\s+/g, " ");
	if (!selection) return items;
	const characters = Array.from(selection);
	const preview = characters.length > 40 ? `${characters.slice(0, 39).join("")}…` : selection;
	items.push(
		{ type: "separator" },
		{ label: labels.lookUp.replace("{{selection}}", () => preview), action: { kind: "lookUp" } },
	);
	return items;
}
