import type { SessionSummary } from "@shared/ipc";
import { i18n } from "../i18n";
import { toast } from "../ui";
import { controllerFor, useApp } from "../state/app";

/** Refresh every saved view of the title omp confirmed. */
export async function renameSavedChat(session: SessionSummary, value: string): Promise<void> {
	const result = await window.vomp.invoke("sessions:rename", session.file, value);
	useApp.setState(state => ({ tabs: state.tabs.map(tab => tab.sessionFile === result.file || (!result.movedFrom && session.previousSessionFiles?.includes(tab.sessionFile ?? "")) ? { ...tab, title: result.title } : tab) }));
	for (const tab of useApp.getState().tabs) {
		if (tab.sessionFile === session.file || session.previousSessionFiles?.includes(tab.sessionFile ?? "")) void controllerFor(tab.id)?.loadHistory();
	}
	await useApp.getState().loadSessions(session.cwd);
	if (result.movedFrom) toast({ tone: "warn", message: i18n.t("session:rename.continued"), description: result.file });
}
