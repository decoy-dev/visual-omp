/**
 * The focused chat's outputs, shared by the Outputs pane and its tab badge (which loads with the app
 * while the pane loads from its own chunk): files tools named, plus the files main found that each
 * command made.
 */
import type { PaneMadeFile } from "@shared/contracts/panes";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { activeBranch, type SavedParents, savedParents } from "../../state/history";
import { liveEntries, type SessionController, type SessionView } from "../../state/session";
import { useHomeDir } from "../projects/folders/FolderBrowser";
import { type ChatOutput, chatOutputs, type MadeCandidate, type MadeFiles, madeCandidates } from "./derive";

// ── files made by commands ──────────────────────────────────────────────────────────────────────

/** Files main found that each tool call made, by call id. */
const useMade = create<Record<string, readonly PaneMadeFile[]>>(() => ({}));
/**
 * Outputs pane mounts so far. It also numbers the scans: reopening the pane checks every call again (files that are
 * gone drop out), and its image cache starts over.
 */
let paneMounts = 0;

/** Counts an Outputs pane mount; returns its number (see `paneMounts`). */
export function countOutputsMount(): number {
	return ++paneMounts;
}

/** `<mount>@<window end>` each call was last checked at; a background job whose result arrived is checked again. */
const scanned = new Map<string, string>();
const SCAN_BATCH = 64;
/** The scan queue: one batch in flight at a time across every chat, so main's per-request limits bound the total work. */
let scanQueue: Promise<void> = Promise.resolve();

async function scanBatch(batch: readonly MadeCandidate[]): Promise<void> {
	const results = await window.vomp.invoke("panes:scanMade", batch.map(({ paths, start, end }) => ({ paths, start, end })));
	const files = { ...useMade.getState() };
	batch.forEach((candidate, n) => {
		const found = results[n] ?? [];
		if (found.length > 0) files[candidate.id] = found;
		else delete files[candidate.id];
	});
	// Replace, so calls whose files are gone lose their entry.
	useMade.setState(files, true);
}

function requestScan(candidates: readonly MadeCandidate[], generation: number): void {
	const due = candidates.filter(candidate => scanned.get(candidate.id) !== `${generation}@${candidate.end}`);
	for (const candidate of due) scanned.set(candidate.id, `${generation}@${candidate.end}`);
	for (let i = 0; i < due.length; i += SCAN_BATCH) {
		const batch = due.slice(i, i + SCAN_BATCH);
		// A failed scan leaves the call without made files; the next reopen tries again.
		scanQueue = scanQueue.then(() => scanBatch(batch)).catch(() => {});
	}
}

// ── outputs of the focused chat ─────────────────────────────────────────────────────────────────

interface Branch {
	leaf: string | null;
	saved: SavedParents | undefined;
	cwd: string | null;
	home: string | null;
	entries: readonly SessionEntry[];
	candidates: MadeCandidate[];
}

export interface Derived {
	made: MadeFiles;
	outputs: ChatOutput[];
	/** Newest result time the outputs could come from, including calls whose made files are still being checked. */
	latest: number;
}

/** Keyed by the session's entry list (then the branch), so the pane and its tab badge share one derivation per update. */
const branches = new WeakMap<readonly SessionEntry[], Branch>();
const derived = new WeakMap<Branch, Derived>();

/**
 * The chat's outputs from the entries the transcript shows: the live stream's active branch, else the saved
 * history, plus the files main found that its commands made. Null until either has loaded.
 */
export function useChatOutputs(session: SessionController | null, view: SessionView | null): Derived | null {
	const home = useHomeDir();
	const liveSource = liveEntries(view);
	const live = liveSource !== null;
	const source = liveSource ?? view?.history?.entries ?? null;
	const leaf = live ? (view?.displayLeaf ?? null) : null;
	const saved = live ? savedParents(view?.history) : undefined;
	const cwd = view?.history?.header?.cwd ?? session?.projectPath ?? null;
	const branch = useMemo(() => {
		if (!source) return null;
		const cached = branches.get(source);
		if (cached && cached.leaf === leaf && cached.saved === saved && cached.cwd === cwd && cached.home === home) return cached;
		const entries = live ? activeBranch(source, leaf, saved) : source;
		const next: Branch = { leaf, saved, cwd, home, entries, candidates: madeCandidates(entries, { cwd, home }) };
		branches.set(source, next);
		return next;
	}, [source, live, leaf, saved, cwd, home]);
	const made = useMade();
	// Read during render: the pane counts its mount before this hook runs, so its first scan already uses it.
	const generation = paneMounts;
	useEffect(() => {
		if (branch) requestScan(branch.candidates, generation);
	}, [branch, generation]);
	return useMemo(() => {
		if (!branch) return null;
		const cached = derived.get(branch);
		if (cached && cached.made === made) return cached;
		const outputs = chatOutputs(branch.entries, { cwd: branch.cwd, home: branch.home }, made);
		let latest = 0;
		for (const candidate of branch.candidates) latest = Math.max(latest, candidate.end);
		for (const output of outputs) latest = Math.max(latest, output.time);
		const next = { made, outputs, latest };
		derived.set(branch, next);
		return next;
	}, [branch, made]);
}
