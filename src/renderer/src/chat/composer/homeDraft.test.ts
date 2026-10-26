import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
	});
});

import { HOME_DRAFT, useComposerDrafts } from "./drafts";

const image = { path: "/images/mock.png", name: "mock.png" };
const snapshot = () => {
	const state = useComposerDrafts.getState();
	return { folder: state.homeFolder, text: state.drafts[HOME_DRAFT] ?? "", images: state.attachments[HOME_DRAFT] ?? [] };
};

beforeEach(() => {
	useComposerDrafts.setState({ homeFolder: null, drafts: {}, attachments: {}, pendingFocus: {}, modes: {} });
});

describe("Home draft destination", () => {
	it.each(["text", "attachment", "both"])("keeps the chosen folder when returning with %s", content => {
		const state = useComposerDrafts.getState();
		state.setHomeFolder("/chosen");
		if (content !== "attachment") state.setDraft(HOME_DRAFT, "Keep this task in its chosen folder");
		if (content !== "text") state.addAttachments(HOME_DRAFT, [image]);
		const before = snapshot();
		state.visitHome();
		expect(snapshot()).toEqual(before);
	});

	it("keeps the chosen folder on a quick return while the same Home instance is mounted", () => {
		const state = useComposerDrafts.getState();
		state.visitHome();
		state.setHomeFolder("/chosen");
		state.setDraft(HOME_DRAFT, "Unfinished task");
		state.visitHome();
		state.visitHome();
		expect(snapshot()).toEqual({ folder: "/chosen", text: "Unfinished task", images: [] });
	});

	it("persists the folder alongside the Home text and attachments", async () => {
		const state = useComposerDrafts.getState();
		state.setHomeFolder("/chosen");
		state.setDraft(HOME_DRAFT, "Unfinished task");
		state.addAttachments(HOME_DRAFT, [image]);
		const stored = localStorage.getItem("vomp.composer.drafts");
		expect(stored).not.toBeNull();
		useComposerDrafts.setState({ homeFolder: null, drafts: {}, attachments: {} });
		localStorage.setItem("vomp.composer.drafts", stored!);
		await useComposerDrafts.persist.rehydrate();
		useComposerDrafts.getState().visitHome();
		expect(snapshot()).toEqual({ folder: "/chosen", text: "Unfinished task", images: [image] });
	});

	it("sends the selected folder and resets only after the chat starts", async () => {
		const state = useComposerDrafts.getState();
		state.setHomeFolder("/chosen");
		state.setDraft(HOME_DRAFT, "Send this task");
		state.addAttachments(HOME_DRAFT, [image]);
		const pending = Promise.withResolvers<string | null>();
		const start = vi.fn(() => pending.promise);
		const sending = state.sendHome("/tmp", start);
		expect(start).toHaveBeenCalledWith({ projectPath: "/chosen", text: "Send this task", images: [image] });
		state.visitHome();
		expect(snapshot().folder).toBe("/chosen");
		pending.resolve("new-chat");
		expect(await sending).toBe("new-chat");
		expect(snapshot()).toEqual({ folder: null, text: "", images: [] });
	});

	it("keeps text, attachments and folder when the leave guard cancels the send", async () => {
		const state = useComposerDrafts.getState();
		state.setHomeFolder("/chosen");
		state.setDraft(HOME_DRAFT, "Keep editing");
		state.addAttachments(HOME_DRAFT, [image]);
		const before = snapshot();
		expect(await state.sendHome("/tmp", async () => null)).toBeNull();
		state.visitHome();
		expect(snapshot()).toEqual(before);
	});

	it("keeps the whole draft when starting the chat fails", async () => {
		const state = useComposerDrafts.getState();
		state.setHomeFolder("/chosen");
		state.setDraft(HOME_DRAFT, "Keep editing");
		await expect(state.sendHome("/tmp", async () => { throw new Error("start failed"); })).rejects.toThrow("start failed");
		expect(snapshot()).toEqual({ folder: "/chosen", text: "Keep editing", images: [] });
	});

	it.each(["", " \n "])("returns an empty draft to the default folder", text => {
		const state = useComposerDrafts.getState();
		state.setHomeFolder("/chosen");
		state.setDraft(HOME_DRAFT, text);
		state.visitHome();
		expect(snapshot().folder).toBeNull();
	});

	it("uses the platform default when no folder was chosen", async () => {
		const state = useComposerDrafts.getState();
		state.setDraft(HOME_DRAFT, "A new task");
		const start = vi.fn(async () => "new-chat");
		await state.sendHome("C:\\Temp", start);
		expect(start).toHaveBeenCalledWith({ projectPath: "C:\\Temp", text: "A new task", images: [] });
	});
});
