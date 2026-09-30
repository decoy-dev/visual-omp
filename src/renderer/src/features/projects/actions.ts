/** Project actions shared by the home screen, wizard, commands and sheets. Failures surface as toasts. */
import { useComposerDrafts } from "@/chat/composer/drafts";
import { controllerFor, useApp } from "@/state/app";
import type { FolderChooserProps } from "./folders/FolderChooser";

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Register a folder as a project, refresh the sidebar and show its home. */
export async function addProject(path: string): Promise<void> {
	await window.vomp.invoke("project:add", path);
	await useApp.getState().refreshProjects();
	useApp.getState().openProject(path);
}

/** Open the folder chooser ("Start a chat in…"); `options.purpose: "open"` goes straight to the browser. */
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
	const newTab = state.newChat(path);
	if (newTab) useComposerDrafts.getState().focus(newTab);
}

/** New chat in `projectPath` with `text` waiting in the composer (not sent), focused for editing. */
export function startDraft(projectPath: string, text: string): void {
	const tabId = useApp.getState().newChat(projectPath);
	if (!tabId) return;
	useComposerDrafts.getState().setDraft(tabId, text);
	useComposerDrafts.getState().focus(tabId);
}

/** New chat in `projectPath`; `firstMessage` is sent as soon as omp is ready. */
export function startChat(projectPath: string, firstMessage?: string): void {
	const tabId = useApp.getState().newChat(projectPath);
	const text = firstMessage?.trim();
	if (tabId && text) void controllerFor(tabId)?.send(text);
}
