import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
	});
});

import { composerText, type ComposerMode, useComposerDrafts } from "./drafts";
import { type HistoryDirection, promptHistory, PromptHistoryCursor } from "./history";
import { applyMode } from "./send";

const CHAT = "history-chat";
const ORIGINAL = "  unfinished draft\nkeep this line  ";
const image = { path: "/tmp/attached.png", name: "attached.png" };
const stored = () => localStorage.getItem("vomp.composer.drafts");
const shown = () => composerText(useComposerDrafts.getState(), CHAT);

beforeEach(() => {
	useComposerDrafts.setState({ drafts: {}, previews: {}, attachments: {}, pendingFocus: {}, modes: {}, homeFolder: null });
	useComposerDrafts.getState().setDraft(CHAT, ORIGINAL);
	useComposerDrafts.getState().addAttachments(CHAT, [image]);
});

function browse(cursor: PromptHistoryCursor, direction: HistoryDirection, items: string[], mode: ComposerMode | null = null) {
	const text = shown();
	const caret = direction === "older" ? 0 : text.length;
	const next = cursor.navigate(direction, { text, start: caret, end: caret }, items, mode);
	if (next) useComposerDrafts.getState().setPreview(CHAT, cursor.browsing ? next.text : null);
	return next;
}

describe("transient composer history previews", () => {
	it("keeps the persisted draft and attachments unchanged throughout Up and Down", () => {
		const before = stored();
		const cursor = new PromptHistoryCursor();
		browse(cursor, "older", ["old", "new"]);
		expect(shown()).toBe("new");
		expect(stored()).toBe(before);
		browse(cursor, "older", []);
		expect(shown()).toBe("old");
		expect(stored()).toBe(before);
		browse(cursor, "newer", []);
		browse(cursor, "newer", []);
		expect(shown()).toBe(ORIGINAL);
		expect(stored()).toBe(before);
		expect(useComposerDrafts.getState().attachments[CHAT]).toEqual([image]);
	});

	it("Escape discards only the preview without saving the recalled message", () => {
		const before = stored();
		const cursor = new PromptHistoryCursor();
		browse(cursor, "older", ["sensitive recalled command"]);
		expect(cursor.restore()?.text).toBe(ORIGINAL);
		useComposerDrafts.getState().setPreview(CHAT, null);
		expect(shown()).toBe(ORIGINAL);
		expect(stored()).toBe(before);
	});

	it("reload during browsing restores the unfinished draft, with no recalled text on disk", async () => {
		browse(new PromptHistoryCursor(), "older", ["sensitive recalled command"]);
		const saved = stored()!;
		expect(saved).not.toContain("sensitive recalled command");
		// A new renderer starts with no ephemeral previews, then hydrates only persisted fields.
		useComposerDrafts.setState({ drafts: {}, previews: {}, attachments: {}, modes: {} });
		localStorage.setItem("vomp.composer.drafts", saved);
		await useComposerDrafts.persist.rehydrate();
		expect(shown()).toBe(ORIGINAL);
		expect(useComposerDrafts.getState().attachments[CHAT]).toEqual([image]);
	});

	it.each(["shell", "python"] as const)("keeps %s recalls transient and sends the preview in its mode", mode => {
		useComposerDrafts.getState().setMode(CHAT, mode);
		const before = stored();
		const text = mode === "shell" ? "!secret-command" : "$ secret_code()";
		const items = promptHistory([], [{ text, timestamp: 1 }], [], mode);
		browse(new PromptHistoryCursor(), "older", items, mode);
		expect(applyMode(shown(), mode)).toBe(text);
		expect(stored()).toBe(before);
		useComposerDrafts.getState().setMode(CHAT, null);
		expect(shown()).toBe(ORIGINAL);
	});

	it("editing or inserting into a recall commits that text as the draft", () => {
		browse(new PromptHistoryCursor(), "older", ["recalled"]);
		useComposerDrafts.getState().setDraft(CHAT, "recalled and edited");
		expect(shown()).toBe("recalled and edited");
		expect(useComposerDrafts.getState().previews[CHAT]).toBeUndefined();
		expect(stored()).toContain("recalled and edited");
		useComposerDrafts.getState().setPreview(CHAT, "another recall");
		useComposerDrafts.getState().insert(CHAT, "@file.ts");
		expect(shown()).toBe("another recall @file.ts");
		expect(useComposerDrafts.getState().previews[CHAT]).toBeUndefined();
	});

	it("clearing after a send consumes both draft and preview, independently per chat", () => {
		useComposerDrafts.getState().setPreview("other-chat", "other preview");
		browse(new PromptHistoryCursor(), "older", ["send this"]);
		const submitted = shown();
		useComposerDrafts.getState().setDraft(CHAT, "");
		expect(submitted).toBe("send this");
		expect(shown()).toBe("");
		expect(useComposerDrafts.getState().previews[CHAT]).toBeUndefined();
		expect(composerText(useComposerDrafts.getState(), "other-chat")).toBe("other preview");
	});
});
