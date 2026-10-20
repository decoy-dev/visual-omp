/** Project actions shared by the project overview, Home, the wizard, commands and sheets. Failures surface as toasts. */
import { type Attachment, useComposerDrafts } from "@/chat/composer/drafts";
import { deliver } from "@/chat/composer/send";
import { i18n } from "@/i18n";
import { controllerFor, useApp } from "@/state/app";
import { toast } from "@/ui";
import type { ThinkingLevel } from "../session-tools/screen";
import { routeSlash } from "../session-tools/slash";
import { sendSlashCommand } from "../session-tools/typed";
import type { FolderChooserProps } from "./folders/FolderChooser";

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Register a folder as a project, refresh the sidebar and show its overview. */
export async function addProject(path: string): Promise<void> {
	await window.vomp.invoke("project:add", path);
	await useApp.getState().refreshProjects();
	useApp.getState().openProject(path);
}

/** Register a folder as a project and make it the active one, staying on the current screen (Home's project picker). */
export async function selectProject(path: string): Promise<void> {
	await window.vomp.invoke("project:add", path);
	await useApp.getState().refreshProjects();
	useApp.setState({ activeProject: path });
}

/** Open the folder chooser ("Start a chat in…"); `options.purpose` "open" or "pick" goes straight to the browser. */
export function chooseFolder(options?: FolderChooserProps): void {
	useApp.getState().openSheet("folder-chooser", options);
}

/** ⌘O: browse for a folder in the app (the native picker is one click away), then open it as a project. */
export function openFolder(): void {
	chooseFolder({ purpose: "open" });
}

/**
 * Register `path` as a project and start a chat there. With `tabId`, that chat moves to `path`
 * instead when nothing has been sent in it yet; otherwise a new chat opens.
 */
export async function startChatIn(path: string, tabId?: string): Promise<void> {
	await window.vomp.invoke("project:add", path);
	await useApp.getState().refreshProjects();
	const state = useApp.getState();
	if (!state.expandedProjects.includes(path)) state.toggleProjectExpanded(path);
	if (tabId && state.retargetChat(tabId, path)) return;
	const newTab = await state.newChat(path);
	if (newTab) useComposerDrafts.getState().focus(newTab);
}

/** New chat in `projectPath` with `text` waiting in the composer (not sent), focused for editing. */
export async function startDraft(projectPath: string, text: string): Promise<void> {
	const tabId = await useApp.getState().newChat(projectPath);
	if (!tabId) return;
	useComposerDrafts.getState().setDraft(tabId, text);
	useComposerDrafts.getState().focus(tabId);
}

export interface ChatStart {
	/** First message, sent as soon as omp is ready; a `/command` goes where the composer would send it. */
	text?: string;
	/** Images omp attaches with the first message. */
	images?: readonly Attachment[];
	/** `provider/id` for omp's `--model`; omp's own default when absent. */
	model?: string | null;
	/** Level for omp's `--thinking`; omp's own default when absent. */
	thinking?: ThinkingLevel | null;
}

/**
 * New chat in `projectPath`. The model and thinking level go to omp as launch flags, so nothing is typed into omp
 * and the chat can still move to another folder before its first message; then the first message is sent. A message
 * that fails to send goes back into the new chat's composer. Resolves the chat id, or null when no chat started.
 */
export async function startChat(projectPath: string, start: ChatStart = {}): Promise<string | null> {
	const extraArgs = [...(start.model ? ["--model", start.model] : []), ...(start.thinking ? ["--thinking", start.thinking] : [])];
	const tabId = await useApp.getState().newChat(projectPath, extraArgs.length > 0 ? { extraArgs } : undefined);
	const session = controllerFor(tabId);
	if (!tabId || !session) return null;
	const text = start.text?.trim() ?? "";
	const images = [...(start.images ?? [])];
	if (!text && images.length === 0) return tabId;
	const sending =
		images.length === 0 && text.startsWith("/")
			? routeSlash(session, text).then(handled => (handled ? undefined : sendSlashCommand(session, text)))
			: deliver(session, text, images, false);
	sending.catch((error: unknown) => {
		const drafts = useComposerDrafts.getState();
		if (!(drafts.drafts[tabId] ?? "")) drafts.setDraft(tabId, text);
		drafts.addAttachments(tabId, images);
		toast({ tone: "err", message: i18n.t("composer:send.failed"), description: errorText(error) });
	});
	return tabId;
}
