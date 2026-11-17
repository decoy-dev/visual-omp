/**
 * Settings › General's Folder for new chats (`prefs.newChatFolder`): New chat and Home start chats there. A chosen
 * folder that is no longer a usable directory stops the start and offers to choose another folder or return to
 * omp's unscoped folder.
 */
import { errorText } from "@shared/errors";
import { type HomeDraft, useComposerDrafts } from "@/chat/composer/drafts";
import { i18n } from "@/i18n";
import { useApp } from "@/state/app";
import { toast } from "@/ui";

/** Save the folder for new chats, or null for omp's unscoped folder. Failures show a toast and resolve false. */
export async function saveNewChatFolder(path: string | null): Promise<boolean> {
	try {
		await useApp.getState().setPrefs({ newChatFolder: path });
		return true;
	} catch (error) {
		toast({ tone: "err", message: i18n.t("settings:general.newChatFolder.saveFailed"), description: errorText(error) });
		return false;
	}
}

/** Ask for a folder with the native picker and save it as the folder for new chats. Failures show a toast. */
export async function pickNewChatFolder(): Promise<boolean> {
	let folder: string | null;
	try {
		folder = await window.vomp.invoke("app:pickFolder", i18n.t("settings:general.newChatFolder.pickTitle"));
	} catch (error) {
		toast({ tone: "err", message: i18n.t("settings:general.newChatFolder.saveFailed"), description: errorText(error) });
		return false;
	}
	return folder ? saveNewChatFolder(folder) : false;
}

/** The folder a new chat starts in, or null when the chosen folder is unavailable (a toast then offers the fixes). */
export async function usableNewChatFolder(): Promise<string | null> {
	const state = useApp.getState();
	const chosen = state.prefs?.newChatFolder;
	if (!chosen) return state.defaultChatFolder ?? (await window.vomp.invoke("app:info")).defaultChatFolder;
	if (await window.vomp.invoke("fs:usableDirectory", chosen)) return chosen;
	toast({
		tone: "err",
		message: i18n.t("settings:general.newChatFolder.unavailable"),
		description: chosen,
		action: { label: i18n.t("settings:general.newChatFolder.choose"), onClick: () => void pickNewChatFolder() },
		secondaryAction: { label: i18n.t("settings:general.newChatFolder.reset"), onClick: () => void saveNewChatFolder(null) },
	});
	return null;
}

/**
 * Home's send: a folder picked on Home is used as is; otherwise the folder for new chats must be usable, and when it
 * is not nothing starts and the text and attachments stay in the Home draft. Resolves the chat id, or null.
 */
export async function sendHomeDraft(start: (draft: HomeDraft) => Promise<string | null>): Promise<string | null> {
	const picked = useComposerDrafts.getState().homeFolder;
	const folder = picked ?? await usableNewChatFolder();
	if (!folder) return null;
	return useComposerDrafts.getState().sendHome(folder, start);
}