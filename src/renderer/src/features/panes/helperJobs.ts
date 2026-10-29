import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { GuestClient } from "../../collab/lib/client";
import { parseSessionHistory } from "../../state/history";
import { backgroundJobs, type BackgroundJob } from "./derive";

export interface HelperJobsSnapshot {
	jobs: readonly BackgroundJob[];
	/** A terminal transcript error. Transient null responses retain the previous snapshot and retry. */
	error: string | null;
}

/** Read one helper incrementally until stopped or omp reports a terminal transcript error. */
export function watchHelperJobs(
	client: Pick<GuestClient, "fetchTranscript">,
	id: string,
	cwd: string,
	onUpdate: (snapshot: HelperJobsSnapshot) => void,
): () => void {
	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let offset = 0;
	let text = "";
	let jobs: readonly BackgroundJob[] = [];
	const refresh = async () => {
		try {
			let changed = false;
			let error: string | null = null;
			for (;;) {
				const result = await client.fetchTranscript(id, offset);
				if (cancelled) return;
				if (!result) break;
				if (result.kind === "error") {
					error = result.message;
					break;
				}
				if (result.newSize < offset) {
					offset = 0;
					text = "";
					continue;
				}
				text += result.text;
				changed ||= result.text.length > 0;
				if (result.newSize <= offset || !result.text) break;
				offset = result.newSize;
			}
			if (changed) {
				const history = parseSessionHistory(text);
				jobs = backgroundJobs(history.all as unknown as readonly SessionEntry[], true, undefined, undefined, history.header?.cwd ?? cwd);
			}
			if (changed || error !== null) onUpdate({ jobs, error });
			if (error !== null) return;
		} catch {
			// Transport failures remain retryable while this reader is active.
		}
		if (!cancelled) timer = setTimeout(() => void refresh(), 2000);
	};
	void refresh();
	return () => {
		cancelled = true;
		clearTimeout(timer);
	};
}
