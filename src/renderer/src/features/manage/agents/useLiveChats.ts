import { useEffect, useMemo, useReducer } from "react";
import { controllerFor, useApp } from "@/state/app";
import { type LiveChat, runningAgentChats } from "./agentsModel";

/** Agent name → titles of open chats where that helper is running now; updates live. */
export function useRunningAgents(untitled: string): Map<string, string[]> {
	const tabs = useApp(state => state.tabs);
	const [version, bump] = useReducer((count: number) => count + 1, 0);
	useEffect(() => {
		const offs = tabs.map(tab => controllerFor(tab.id)?.subscribe(bump));
		return () => {
			for (const off of offs) off?.();
		};
	}, [tabs]);
	return useMemo(() => {
		void version;
		const chats: LiveChat[] = tabs.map(tab => {
			const view = controllerFor(tab.id)?.getSnapshot();
			return { title: view?.guest?.state?.sessionName || tab.title || untitled, guest: view?.guest ?? null };
		});
		return runningAgentChats(chats);
	}, [tabs, version, untitled]);
}
