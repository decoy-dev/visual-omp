import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerDrafts } from "./drafts";

vi.hoisted(() => {
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
		clear: () => storage.clear(),
	});
});

describe("restored editor insertion receipts", () => {
	beforeEach(() => { localStorage.clear(); useComposerDrafts.setState({ drafts: {}, previews: {}, editorRestores: {} }); });
	it("inserts once through repeated recovery and a renderer reload before acknowledgement", async () => {
		const store = useComposerDrafts.getState();
		store.setDraft("chat", "Newer app draft");
		store.restoreEditor("chat", "capture-1", "Exact queued text 日本語");
		store.restoreEditor("chat", "capture-1", "Exact queued text 日本語");
		expect(useComposerDrafts.getState().drafts.chat).toBe("Newer app draft\nExact queued text 日本語");
		const saved = localStorage.getItem("vomp.composer.drafts")!;
		useComposerDrafts.setState({ drafts: {}, editorRestores: {} });
		localStorage.setItem("vomp.composer.drafts", saved);
		await useComposerDrafts.persist.rehydrate();
		useComposerDrafts.getState().restoreEditor("chat", "capture-1", "Exact queued text 日本語");
		expect(useComposerDrafts.getState().drafts.chat).toBe("Newer app draft\nExact queued text 日本語");
		useComposerDrafts.getState().restoreEditor("chat", "capture-2", "Next restored text");
		useComposerDrafts.getState().restoreEditor("chat", "capture-1", "Exact queued text 日本語");
		expect(useComposerDrafts.getState().drafts.chat).toBe("Newer app draft\nExact queued text 日本語\nNext restored text");
	});
});
