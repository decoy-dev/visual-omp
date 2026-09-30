/**
 * The permission mode shown in the composer pill and the header mode chip.
 *
 * omp 18.4.4 has no slash command or keybinding that changes approval for a running chat: the mode is
 * the `tools.approvalMode` setting (`--approval-mode` only applies at launch). A running omp watches its
 * config files and applies changes live (config/settings.ts `#syncFileWatchers`), so the pill writes
 * the setting for this project (`<project>/.omp/config.yml`) and every chat in the project follows.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ApprovalMode, ApprovalState } from "@shared/contracts/config";

interface Entry {
	state: ApprovalState | null;
	error: string | null;
	listeners: Set<() => void>;
	snapshot: ApprovalSnapshot;
	stopWatch: (() => void) | null;
}

export interface ApprovalSnapshot {
	/** null while loading. */
	mode: ApprovalMode | null;
	/** The project file sets it (otherwise global config or omp's default decides). */
	fromProject: boolean;
	error: string | null;
}

const entries = new Map<string, Entry>();

function entryFor(cwd: string): Entry {
	let entry = entries.get(cwd);
	if (!entry) {
		entry = { state: null, error: null, listeners: new Set(), snapshot: { mode: null, fromProject: false, error: null }, stopWatch: null };
		entries.set(cwd, entry);
	}
	return entry;
}

function publish(entry: Entry): void {
	entry.snapshot = {
		mode: entry.state?.mode ?? null,
		fromProject: entry.state?.modeSource === "project",
		error: entry.error,
	};
	for (const listener of entry.listeners) listener();
}

async function load(cwd: string): Promise<void> {
	const entry = entryFor(cwd);
	try {
		entry.state = await window.vomp.invoke("config:approval", cwd);
		entry.error = null;
	} catch (error) {
		entry.error = error instanceof Error ? error.message : String(error);
	}
	publish(entry);
}

function subscribe(cwd: string, listener: () => void): () => void {
	const entry = entryFor(cwd);
	entry.listeners.add(listener);
	if (entry.listeners.size === 1) {
		void window.vomp.invoke("config:watch", cwd).catch(() => undefined);
		const off = window.vomp.on("config:changed", event => {
			if (event.scope === "global" || event.cwd === cwd) void load(cwd);
		});
		entry.stopWatch = () => {
			off();
			void window.vomp.invoke("config:unwatch", cwd).catch(() => undefined);
		};
	}
	return () => {
		entry.listeners.delete(listener);
		if (entry.listeners.size === 0) {
			entry.stopWatch?.();
			entry.stopWatch = null;
		}
	};
}

export function useApprovalMode(cwd: string): ApprovalSnapshot {
	const subscribeCwd = useCallback((listener: () => void) => subscribe(cwd, listener), [cwd]);
	const snapshot = useSyncExternalStore(subscribeCwd, () => entryFor(cwd).snapshot);
	// A write from another feature emits no config:changed for the app's own writes; re-read on mount.
	useEffect(() => {
		void load(cwd);
	}, [cwd]);
	return snapshot;
}

/** Write the project's approval mode; resolves the new effective state. */
export async function setApprovalMode(cwd: string, mode: ApprovalMode): Promise<ApprovalState> {
	const entry = entryFor(cwd);
	const state = await window.vomp.invoke("config:approval:setMode", mode, "project", cwd);
	entry.state = state;
	entry.error = null;
	publish(entry);
	return state;
}

const AUTO_ACK_KEY = "visual-omp:auto-mode-acknowledged";

/** DESIGN §8.4: the Auto warning shows once. */
export function autoAcknowledged(): boolean {
	return localStorage.getItem(AUTO_ACK_KEY) === "1";
}

export function acknowledgeAuto(): void {
	localStorage.setItem(AUTO_ACK_KEY, "1");
}
