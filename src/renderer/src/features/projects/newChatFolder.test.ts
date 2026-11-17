// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import type { AppPreferences } from "@shared/ipc";

const fake = vi.hoisted(() => ({ toast: vi.fn(), invoke: vi.fn(), setPrefs: vi.fn(), state: { prefs: null as Partial<AppPreferences> | null, defaultChatFolder: "/tmp" as string | null } }));
vi.mock("@/ui", () => ({ toast: fake.toast }));
vi.mock("@/i18n", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/state/app", () => ({ useApp: { getState: () => ({ ...fake.state, setPrefs: fake.setPrefs }) } }));
import { HOME_DRAFT, useComposerDrafts } from "@/chat/composer/drafts";
import { pickNewChatFolder, saveNewChatFolder, sendHomeDraft, usableNewChatFolder } from "./newChatFolder";

const image = { id: "a", name: "shot.png", mimeType: "image/png", data: "AAAA" } as never;

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(window, { vomp: { invoke: fake.invoke } });
	fake.state = { prefs: null, defaultChatFolder: "/tmp" };
	useComposerDrafts.setState({ homeFolder: null, drafts: { [HOME_DRAFT]: "fix the build" }, attachments: { [HOME_DRAFT]: [image] } });
});

it("uses the chosen folder while it is a usable directory, and omp's folder without one", async () => {
	expect(await usableNewChatFolder()).toBe("/tmp");
	expect(fake.invoke).not.toHaveBeenCalled();
	fake.state.prefs = { newChatFolder: "/work/inbox" };
	fake.invoke.mockResolvedValue(true);
	expect(await usableNewChatFolder()).toBe("/work/inbox");
	expect(fake.invoke).toHaveBeenCalledWith("fs:usableDirectory", "/work/inbox");
});

it("starts nothing when the chosen folder is unavailable, and offers Choose and Use default", async () => {
	fake.state.prefs = { newChatFolder: "/gone" };
	fake.invoke.mockResolvedValue(false);
	expect(await usableNewChatFolder()).toBeNull();
	const shown = fake.toast.mock.calls[0]![0];
	expect(shown).toMatchObject({ tone: "err", message: "settings:general.newChatFolder.unavailable", description: "/gone", action: { label: "settings:general.newChatFolder.choose" }, secondaryAction: { label: "settings:general.newChatFolder.reset" } });
	fake.setPrefs.mockResolvedValue(undefined);
	shown.secondaryAction.onClick();
	expect(fake.setPrefs).toHaveBeenCalledWith({ newChatFolder: null });
});

it("reports a failed save or a failed folder picker instead of dropping it", async () => {
	fake.setPrefs.mockRejectedValue(new Error("disk full"));
	expect(await saveNewChatFolder("/work/inbox")).toBe(false);
	fake.invoke.mockRejectedValue(new Error("picker closed unexpectedly"));
	expect(await pickNewChatFolder()).toBe(false);
	expect(fake.toast).toHaveBeenCalledTimes(2);
	expect(fake.toast).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "err", description: "picker closed unexpectedly" }));
});

it("sends Home's draft to a folder picked on Home without checking the default folder", async () => {
	fake.state.prefs = { newChatFolder: "/gone" };
	useComposerDrafts.setState({ homeFolder: "/picked" });
	const start = vi.fn(async () => "tab-1");
	expect(await sendHomeDraft(start)).toBe("tab-1");
	expect(start).toHaveBeenCalledWith({ projectPath: "/picked", text: "fix the build", images: [image] });
	expect(fake.invoke).not.toHaveBeenCalled();
});

it("keeps Home's text and attachments when the folder for new chats is unavailable", async () => {
	fake.state.prefs = { newChatFolder: "/gone" };
	fake.invoke.mockResolvedValue(false);
	const start = vi.fn(async () => "tab-1");
	expect(await sendHomeDraft(start)).toBeNull();
	expect(start).not.toHaveBeenCalled();
	const drafts = useComposerDrafts.getState();
	expect(drafts.drafts[HOME_DRAFT]).toBe("fix the build");
	expect(drafts.attachments[HOME_DRAFT]).toEqual([image]);
});
