import type { NativeSnapshot } from "@shared/contracts/native";
import { compareSemver } from "@shared/semver";
import type { SessionView } from "./session";
import { activeBranch, savedParents } from "./history";

/** Use the running host's version, never a newer installation waiting for restart. */
export function supportsContinue(native: NativeSnapshot | null, view: SessionView): boolean {
	return !!native?.ompVersion && native.asyncJobsGeneration === view.host?.generation
		&& compareSemver(native.ompVersion, "18.18.2") >= 0;
}

/** Continue owns no question answers and never starts a saved or disconnected chat. */
export function continueEligible(view: SessionView): boolean {
	const host = view.host;
	if (view.mode !== "live" || !host || host.phase !== "live" || view.readOnly || view.strandedImages
		|| view.guest?.phase !== "live" || view.guest.readOnly || view.guest.uiRequest || view.guest.pendingUiRequests?.length) return false;
	if (host.transport === "tsp") {
		if (!host.tspAvailability?.available || host.tspComposer?.blockedBy || host.tspComposer?.queued.length) return false;
	} else if (!host.tui || host.tui.overlays !== 0) return false;
	if (view.working) return true;
	const entries = activeBranch(view.guest.entries, view.displayLeaf, savedParents(view.history));
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") return true;
		if (entry.message.role === "assistant") return entry.message.stopReason === "aborted" || entry.message.stopReason === "error" || entry.message.stopReason === "toolUse";
	}
	return false;
}
