/** Live-share ("Invite") state per omp host, kept current from main's `collab:shareState` events. */
import type { LiveShareState } from "@shared/contracts/collab";
import { create } from "zustand";

interface ShareStore {
	byHost: Record<string, LiveShareState>;
	/** Ask main for a host's state (the dialog can open mid-share, e.g. after a window reload). */
	load(hostId: string): Promise<void>;
	start(hostId: string): Promise<LiveShareState>;
}

export const useShares = create<ShareStore>()(set => ({
	byHost: {},
	async load(hostId) {
		const state = await window.vomp.invoke("collab:shared", hostId);
		if (state) set(store => ({ byHost: { ...store.byHost, [hostId]: state } }));
	},
	async start(hostId) {
		const state = await window.vomp.invoke("collab:publish", hostId);
		set(store => ({ byHost: { ...store.byHost, [hostId]: state } }));
		return state;
	},
}));

window.vomp.on("collab:shareState", state => {
	useShares.setState(store => ({ byHost: { ...store.byHost, [state.hostId]: state } }));
});
