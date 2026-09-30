/** Project actions shared by the home screen, wizard, commands and sheets. Failures surface as toasts. */
import { useComposerDrafts } from "@/chat/composer/drafts";
import { i18n } from "@/i18n";
import { controllerFor, useApp } from "@/state/app";
import { toast } from "@/ui";

const t = i18n.t.bind(i18n);

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Register a folder as a project, refresh the sidebar and show its home. */
export async function addProject(path: string): Promise<void> {
	await window.vomp.invoke("project:add", path);
	await useApp.getState().refreshProjects();
	useApp.getState().openProject(path);
}

/** ⌘O: native folder picker, then open the folder as a project. */
export async function openFolder(): Promise<void> {
	const path = await window.vomp.invoke("app:pickFolder", t("projects:open.pickerTitle"));
	if (!path) return;
	try {
		await addProject(path);
	} catch (error) {
		toast({ tone: "err", message: t("projects:open.failed"), description: errorText(error) });
	}
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
