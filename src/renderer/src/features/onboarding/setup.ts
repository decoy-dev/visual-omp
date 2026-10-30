import type { AppPreferences, OmpStatus } from "@shared/ipc";
import { create } from "zustand";
import { useApp } from "../../state/app";
import { whenLeaving } from "../../state/leaveGuard";

export const useSetup = create<{ requested: boolean; dismissed: boolean; handoff: boolean }>(() => ({ requested: false, dismissed: false, handoff: false }));

export function ompNeedsSetup(omp: OmpStatus): boolean {
	return !omp.found || !omp.supported || Boolean(omp.refused);
}

export function needsSetup(omp: OmpStatus | null, prefs: Pick<AppPreferences, "setupCompleted"> | null, requested: boolean, dismissed: boolean): boolean {
	return Boolean(omp && prefs && (requested || (!dismissed && (!prefs.setupCompleted || ompNeedsSetup(omp)))));
}

/** Replays the full flow without discarding unsaved settings or stopping open chats. */
export function startSetup(): void {
	void whenLeaving(() => {
		useApp.getState().closeSheet();
		useApp.getState().setPaletteOpen(false);
		useSetup.setState({ requested: true, dismissed: false, handoff: false });
	});
}

/** Exiting saves completion too, matching omp's own setup behaviour. */
export async function finishSetup(): Promise<void> {
	await useApp.getState().setPrefs({ setupCompleted: true });
	useSetup.setState({ requested: false, dismissed: true });
}

export type SetupStep = "welcome" | "install" | "providers" | "model" | "permission" | "appearance" | "done";

export function setupSteps(installRequired: boolean, installOnly: boolean): SetupStep[] {
	if (installOnly) return ["install"];
	return ["welcome", ...(installRequired ? ["install" as const] : []), "providers", "model", "permission", "appearance", "done"];
}
