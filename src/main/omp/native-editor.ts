import type { EditorDraftRequest, EditorDraftResult } from "@shared/contracts/composer";

interface ExactEditorUI {
	getEditorText(): string;
	setEditorText(text: string): void;
	theme?: { symbol(key: "chip.image"): string };
}

/** Embedded in the trusted extension. This function must remain self-contained when serialized. */
export function exactEditorDraft(ui: ExactEditorUI, request: EditorDraftRequest, sessionId: string): EditorDraftResult {
	if (sessionId !== request.sessionId) return { text: null, cleared: false, error: "The chat changed before its editor could be read." };
	let text: string;
	try { text = ui.getEditorText(); }
	catch (error) { return { text: null, cleared: false, error: String(error) }; }
	let imageChips: number | undefined;
	const symbol = ui.theme?.symbol("chip.image");
	if (symbol) {
		imageChips = 0;
		for (let offset = text.indexOf(`${symbol} #`); offset >= 0; offset = text.indexOf(`${symbol} #`, offset + symbol.length + 2)) {
			if (/^[1-9]\d*/.test(text.slice(offset + symbol.length + 2))) imageChips++;
		}
	}
	if (request.operation === "peek") return { text, cleared: text === "", ...(imageChips === undefined ? {} : { imageChips, imageSymbol: symbol }) };
	if (request.operation === "take" && text === "") return { text, cleared: true };
	if (text !== request.expected) return { text, cleared: false, error: "omp's editor changed. Its newer text was left unchanged." };
	if (request.operation === "restore") {
		if (request.restoreText === undefined) return { text, cleared: false, restored: false, error: "The original editor text is required." };
		try {
			ui.setEditorText(request.restoreText);
			const restored = ui.getEditorText() === request.restoreText;
			return { text, cleared: restored && request.restoreText === "", restored, ...(restored ? {} : { error: "omp's original editor text could not be restored." }) };
		} catch (error) {
			return { text, cleared: false, restored: false, error: String(error) };
		}
	}
	try {
		// Read, compare, clear and verify without an await or another editor operation between them.
		ui.setEditorText("");
		if (ui.getEditorText() === "") return { text, cleared: true };
		return { text, cleared: false, error: "omp's editor did not clear. Its current text was left unchanged." };
	} catch (error) {
		try {
			// A failed verification can follow a successful clear. Restore the exact captured text only into an empty editor.
			if (ui.getEditorText() === "") ui.setEditorText(text);
		} catch { /* Main already retains the exact captured text before requesting a clear. */ }
		return { text, cleared: false, error: String(error) };
	}
}
