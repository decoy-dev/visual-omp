import type { SettingInfo } from "@shared/contracts/config";
import { useEffect, useSyncExternalStore } from "react";

/**
 * omp's effective settings per project folder, for the context popover's compaction preview. Reading them runs
 * omp several times, so the composer starts the read when the context ring appears, the popover shows the last
 * answer at once and every opening reads them again. A failed read keeps the last answer and says so.
 */
type Settings = ReadonlyMap<string, SettingInfo>;
interface Entry {
	data: Settings | null;
	/** The latest read failed; `data`, if any, is from an earlier read. */
	failed: boolean;
	pending: boolean;
}
const empty: Entry = { data: null, failed: false, pending: false };
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

function update(cwd: string, change: Partial<Entry>): void {
	cache.set(cwd, { ...(cache.get(cwd) ?? empty), ...change });
	for (const listener of listeners) listener();
}
function read(cwd: string): void {
	if (cache.get(cwd)?.pending) return;
	update(cwd, { pending: true });
	window.vomp.invoke("config:list", cwd).then(
		snapshot => update(cwd, { data: new Map(snapshot.settings.map(setting => [setting.key, setting])), failed: false, pending: false }),
		() => update(cwd, { failed: true, pending: false }),
	);
}
function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/** Starts reading `cwd`'s settings unless an answer is already on hand. */
export function prefetchCompactionSettings(cwd: string): void {
	if (!cache.get(cwd)?.data) read(cwd);
}

export interface CompactionSettings {
	/** The last settings read for the folder; null until a read succeeds. */
	settings: Settings | null;
	/** The latest read failed and none is running; `settings` is from an earlier read, if any. */
	failed: boolean;
	retry(): void;
}
/** The folder's settings, read again once per mount. */
export function useCompactionSettings(cwd: string): CompactionSettings {
	const entry = useSyncExternalStore(subscribe, () => cache.get(cwd) ?? empty);
	useEffect(() => { read(cwd); }, [cwd]);
	return { settings: entry.data, failed: entry.failed && !entry.pending, retry: () => read(cwd) };
}
