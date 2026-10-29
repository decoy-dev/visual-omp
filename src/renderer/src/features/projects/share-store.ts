/** Live invites and the most recent local export/import operation. No file output is persisted. */
import type { LiveShareState } from "@shared/contracts/collab";
import type { AnonymizedCopyResult, ShareFileResult } from "@shared/contracts/share";
import { create } from "zustand";

export type ShareFileAction = "pack" | "unpack" | "anonymize";
export type ShareFileState = {
	kind: ShareFileAction;
	sessionFile: string | null;
} & (
	| { phase: "busy" | "cancelled" }
	| { phase: "done"; result: ShareFileResult | AnonymizedCopyResult }
	| { phase: "error"; error: string }
);

interface ShareStore {
	byHost: Record<string, LiveShareState>;
	fileAction: ShareFileState | null;
	runFileAction(kind: ShareFileAction, sessionFile?: string | null): Promise<void>;
	/** Ask main for a host's state (the dialog can open mid-share, e.g. after a window reload). */
	load(hostId: string): Promise<void>;
	start(hostId: string): Promise<LiveShareState>;
}

export const useShares = create<ShareStore>()((set, get) => ({
	byHost: {},
	fileAction: null,
	async runFileAction(kind, sessionFile = null) {
		if (get().fileAction?.phase === "busy") return;
		if (kind !== "unpack" && !sessionFile) return;
		const scope = { kind, sessionFile };
		set({ fileAction: { ...scope, phase: "busy" } });
		try {
			const result = kind === "unpack"
				? await window.vomp.invoke("share:unpack")
				: kind === "pack"
					? await window.vomp.invoke("share:pack", sessionFile!)
					: await window.vomp.invoke("share:anonymize", sessionFile!);
			set({ fileAction: result ? { ...scope, phase: "done", result } : { ...scope, phase: "cancelled" } });
		} catch (error) {
			set({ fileAction: { ...scope, phase: "error", error: error instanceof Error ? error.message : String(error) } });
		}
	},
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
