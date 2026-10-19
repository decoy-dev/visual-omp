/**
 * The entries a chat shows: the live mirror's branch ending at the displayed leaf (after a rewind, the leaf the user
 * moved to), else the saved history. The transcript, the header work chip and the Tasks pane all read this, so a
 * rewound chat never counts tasks from a branch it no longer shows.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { useMemo } from "react";
import { activeBranch, savedParents } from "../state/history";
import { liveEntries, type SessionView } from "../state/session";

const NONE: readonly SessionEntry[] = [];

/** The displayed branch for one snapshot (callers outside React render). */
export function displayedEntries(view: SessionView | null | undefined): readonly SessionEntry[] {
	const live = liveEntries(view);
	return live ? activeBranch(live, view?.displayLeaf ?? null, savedParents(view?.history ?? null)) : (view?.history?.entries ?? NONE);
}

export function useDisplayedEntries(view: SessionView | null | undefined): readonly SessionEntry[] {
	const live = liveEntries(view);
	const leaf = view?.displayLeaf ?? null;
	const history = view?.history ?? null;
	return useMemo(() => displayedEntries(view), [live, leaf, history]);
}
