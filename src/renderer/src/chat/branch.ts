/**
 * The entries a chat shows: the live mirror's branch ending at the displayed leaf (after a rewind, the leaf the user
 * moved to), else the saved history. The transcript, the header work chip and the Tasks pane all read this, so a
 * rewound chat never counts tasks from a branch it no longer shows.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { useMemo } from "react";
import { activeBranch, savedParents, type SavedParents, type SessionHistory } from "../state/history";
import { liveEntries, type SessionView } from "../state/session";

const NONE: readonly SessionEntry[] = [];

interface BranchProjection {
	leaf: string | null;
	parents: SavedParents | undefined;
	entries: readonly SessionEntry[];
}
// One selected leaf per immutable source array. Old snapshots are not retained by the cache.
const projections = new WeakMap<readonly SessionEntry[], BranchProjection>();

function projectBranch(live: readonly SessionEntry[], leaf: string | null, history: SessionHistory | null): readonly SessionEntry[] {
	const parents = savedParents(history);
	const previous = projections.get(live);
	if (previous && previous.leaf === leaf && previous.parents === parents) return previous.entries;
	const entries = live.length ? activeBranch(live, leaf, parents) : NONE;
	projections.set(live, { leaf, parents, entries });
	return entries;
}

/** The displayed branch for one snapshot (callers outside React render). */
export function displayedEntries(view: SessionView | null | undefined): readonly SessionEntry[] {
	const live = liveEntries(view);
	return live ? projectBranch(live, view?.displayLeaf ?? null, view?.history ?? null) : (view?.history?.entries ?? NONE);
}

export function useDisplayedEntries(view: SessionView | null | undefined): readonly SessionEntry[] {
	const live = liveEntries(view);
	const leaf = view?.displayLeaf ?? null;
	const history = view?.history ?? null;
	return useBranchEntries(live, leaf, history);
}

/** The same branch projection for consumers that select transcript inputs rather than a whole SessionView. */
export function useBranchEntries(live: readonly SessionEntry[] | null, leaf: string | null, history: SessionHistory | null): readonly SessionEntry[] {
	return useMemo(() => live ? projectBranch(live, leaf, history) : (history?.entries ?? NONE), [live, leaf, history]);
}
