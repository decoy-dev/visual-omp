import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";

/** Best-known title of a chat: omp's live session name, the saved title, then the tab's title. */
export function chatTitle(controller: SessionController): string | null {
	const view = controller.getSnapshot();
	return (
		view.guest?.state?.sessionName ||
		view.history?.title ||
		useApp.getState().tabs.find(tab => tab.id === controller.tabId)?.title ||
		null
	);
}

