import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { GuestClient, TranscriptResult } from "../../collab/lib/client";
import { parseSessionHistory } from "../../state/history";
import { backgroundJobs, type BackgroundJob } from "./derive";

type TranscriptClient = Pick<GuestClient, "fetchTranscript">;

// omp queues each transcript reply (up to 4 MiB) for the guest and ends the room once its send backlog passes
// 16 MiB or 256 frames. Reading every helper at once overflowed it in chats with many helpers, so the app keeps
// one transcript request in flight per connection.
const tails = new WeakMap<TranscriptClient, Promise<unknown>>();

/** `fetchTranscript` through the connection's single-request queue; a reader cancelled while waiting sends nothing. */
export function fetchHelperTranscript(
	client: TranscriptClient,
	id: string,
	offset: number,
	cancelled: () => boolean = () => false,
): Promise<TranscriptResult | null> {
	const run = (tails.get(client) ?? Promise.resolve()).then(() => (cancelled() ? null : client.fetchTranscript(id, offset)));
	tails.set(client, run.catch(() => undefined));
	return run;
}

export interface HelperJobsSnapshot {
	jobs: readonly BackgroundJob[];
	/** A terminal transcript error. Transient null responses retain the previous snapshot and retry. */
	error: string | null;
}

/**
 * Read one helper incrementally until stopped or omp reports a terminal transcript error. A finished helper's
 * transcript no longer grows, so with `follow` false it is read to the end once and not polled again.
 */
export function watchHelperJobs(
	client: TranscriptClient,
	id: string,
	cwd: string,
	follow: boolean,
	onUpdate: (snapshot: HelperJobsSnapshot) => void,
): () => void {
	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let offset = 0;
	let text = "";
	let jobs: readonly BackgroundJob[] = [];
	const refresh = async () => {
		let complete = false;
		try {
			let changed = false;
			let error: string | null = null;
			for (;;) {
				const result = await fetchHelperTranscript(client, id, offset, () => cancelled);
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
				if (result.newSize <= offset || !result.text) {
					complete = true;
					break;
				}
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
		if (!cancelled && (follow || !complete)) timer = setTimeout(() => void refresh(), 2000);
	};
	void refresh();
	return () => {
		cancelled = true;
		clearTimeout(timer);
	};
}
