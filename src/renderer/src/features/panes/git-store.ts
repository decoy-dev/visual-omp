/**
 * Live `git:status` per project folder, shared by the Diff pane and its tab badge. The first
 * subscriber starts `git:watch`; every `git:changed` refetches status and bumps `version` so the
 * pane knows to reload its diff. The last subscriber stops watching.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { GitStatus } from "@shared/contracts/git";

export interface GitView {
	status: GitStatus | null;
	/** Folder is not inside a git work tree. */
	notRepo: boolean;
	error: string | null;
	/** Increments on every observed change of the work tree. */
	version: number;
}

interface Watch {
	view: GitView;
	refs: number;
	listeners: Set<() => void>;
	fetching: boolean;
	dirty: boolean;
}

const EMPTY: GitView = { status: null, notRepo: false, error: null, version: 0 };
const watches = new Map<string, Watch>();
let changedListener: (() => void) | null = null;

function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	// Electron wraps handler errors: "Error invoking remote method 'x': Error: <message>".
	return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

function commit(watch: Watch, patch: Partial<GitView>): void {
	watch.view = { ...watch.view, ...patch };
	for (const listener of watch.listeners) listener();
}

async function refresh(cwd: string): Promise<void> {
	const watch = watches.get(cwd);
	if (!watch) return;
	if (watch.fetching) {
		watch.dirty = true;
		return;
	}
	watch.fetching = true;
	try {
		const status = await window.vomp.invoke("git:status", cwd);
		commit(watch, { status, notRepo: false, error: null, version: watch.view.version + 1 });
	} catch (error) {
		const message = errorText(error);
		const notRepo = message.startsWith("Not a git repository");
		commit(watch, { status: null, notRepo, error: notRepo ? null : message, version: watch.view.version + 1 });
	} finally {
		watch.fetching = false;
		if (watch.dirty) {
			watch.dirty = false;
			void refresh(cwd);
		}
	}
}

function subscribe(cwd: string, listener: () => void): () => void {
	let watch = watches.get(cwd);
	if (!watch) {
		watch = { view: EMPTY, refs: 0, listeners: new Set(), fetching: false, dirty: false };
		watches.set(cwd, watch);
	}
	changedListener ??= window.vomp.on("git:changed", ({ cwd: changed }) => {
		if (watches.has(changed)) void refresh(changed);
	});
	watch.listeners.add(listener);
	if (watch.refs++ === 0) {
		void refresh(cwd);
		window.vomp.invoke("git:watch", cwd).catch(() => {});
	}
	return () => {
		const current = watches.get(cwd);
		if (!current) return;
		current.listeners.delete(listener);
		if (--current.refs === 0) {
			watches.delete(cwd);
			window.vomp.invoke("git:unwatch", cwd).catch(() => {});
		}
	};
}

/** Refetch now (after a discard, or when omp finishes a turn). */
export function refreshGit(cwd: string): void {
	void refresh(cwd);
}

export function useGit(cwd: string | null): GitView {
	const sub = useCallback((listener: () => void) => (cwd ? subscribe(cwd, listener) : () => {}), [cwd]);
	const get = useCallback(() => (cwd ? (watches.get(cwd)?.view ?? EMPTY) : EMPTY), [cwd]);
	return useSyncExternalStore(sub, get);
}
