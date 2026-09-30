import { type DependencyList, type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/state/app";

/** Error text without Electron's `Error invoking remote method '…': Error:` wrapper. */
export function ipcErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^(?:[A-Za-z]*Error:\s*)+/, "");
}

export interface Resource<T> {
	data: T | null;
	error: string | null;
	loading: boolean;
	reload(): Promise<void>;
	/** Replace the data with a fresher value returned by a write (updater form for concurrent writes). */
	setData: Dispatch<SetStateAction<T | null>>;
}

/** Loads `load()` when `deps` change; stale responses from earlier deps are dropped. */
export function useResource<T>(load: () => Promise<T>, deps: DependencyList): Resource<T> {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const seq = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: callers pass the inputs of `load` as deps.
	const reload = useCallback(async () => {
		const mine = ++seq.current;
		setLoading(true);
		try {
			const next = await load();
			if (mine !== seq.current) return;
			setData(next);
			setError(null);
		} catch (err) {
			if (mine === seq.current) setError(ipcErrorMessage(err));
		} finally {
			if (mine === seq.current) setLoading(false);
		}
	}, deps);
	useEffect(() => {
		void reload();
	}, [reload]);
	return { data, error, loading, reload, setData };
}

/**
 * Watches omp's global config (and the project's, with `cwd`) while mounted and reports edits made
 * outside the app. The app's own writes never trigger `config:changed`.
 */
export function useExternalConfigChange(cwd: string | null): [changed: boolean, clear: () => void] {
	const [changed, setChanged] = useState(false);
	useEffect(() => {
		const arg = cwd ?? undefined;
		void window.vomp.invoke("config:watch", arg);
		const off = window.vomp.on("config:changed", event => {
			if (event.scope === "global" || event.cwd === cwd) setChanged(true);
		});
		return () => {
			off();
			void window.vomp.invoke("config:unwatch", arg);
		};
	}, [cwd]);
	return [changed, useCallback(() => setChanged(false), [])];
}

/** Project a sheet acts on: the one it was opened for, else the focused project. */
export function useSheetProject(explicit: string | null | undefined): string | null {
	const active = useApp(state => state.activeProject);
	return explicit === undefined ? active : explicit;
}

/** Last path segment, for showing a project folder by name. */
export function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
