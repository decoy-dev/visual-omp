import type { SessionSummary } from "@shared/ipc";
import type { ChatTab } from "../state/app";
import type { SessionController } from "../state/session";
import { chatTitle } from "./hooks";
import type { SidebarInput } from "./sidebarRows";

/** A title-only snapshot keeps sorting and search current without rerendering for every streamed token. */
export function sidebarTitles(
	tabs: readonly ChatTab[],
	sessionsByProject: Readonly<Record<string, readonly SessionSummary[]>>,
	controllerFor: (tabId: string) => Pick<SessionController, "getSnapshot" | "subscribe"> | null,
	labels: Pick<SidebarInput, "untitledTitle" | "newChatTitle">,
) {
	const sources = tabs.map(tab => {
		const session = tab.sessionFile ? sessionsByProject[tab.projectPath]?.find(saved =>
			saved.file === tab.sessionFile || saved.previousSessionFiles?.includes(tab.sessionFile!),
		) : undefined;
		return { tab, session, controller: controllerFor(tab.id) };
	});
	const readTitle = ({ tab, session, controller }: (typeof sources)[number]) =>
		chatTitle(controller?.getSnapshot() ?? null, session?.title ?? tab.title) ?? session?.preview
			?? (session ? labels.untitledTitle : labels.newChatTitle);
	let snapshot = new Map(sources.map(source => [source.tab.id, readTitle(source)]));
	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			const detach = sources.flatMap(source => {
				const update = () => {
					const title = readTitle(source);
					if (snapshot.get(source.tab.id) === title) return;
					snapshot = new Map(snapshot).set(source.tab.id, title);
					listener();
				};
				const stop = source.controller?.subscribe(update);
				// A controller can change between the first render and React attaching its subscription.
				update();
				return stop ? [stop] : [];
			});
			return () => { for (const stop of detach) stop(); };
		},
	};
}
