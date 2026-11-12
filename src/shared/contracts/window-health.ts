/**
 * A slowdown the window is going through: it answers late or not at all, updates for some chats are waiting to reach
 * it, or some chats' window connections keep restarting because their updates fell behind. Chats are host ids.
 */
export interface WindowHealthIncident {
	/** Stays the same while one slowdown lasts, so a dismissed warning stays dismissed. */
	id: number;
	slow: boolean;
	delayed: string[];
	resyncing: string[];
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** The page installed its heartbeat answer, so main can start sending heartbeats to it. */
		"window:ready": { args: []; result: void };
		/** The window answering main's heartbeat `seq`. */
		"window:heartbeat": { args: [seq: number]; result: void };
		/** Ask (natively) before reloading the window; resolves true when it reloads. */
		"window:reload": { args: []; result: boolean };
		/** The person acted on the warning (for example closed idle chats), so it waits a minute before warning again. */
		"window:healthActed": { args: []; result: void };
	}
	interface IpcEventMap {
		/** Main's heartbeat; the window answers through `window:heartbeat`. */
		"window:ping": number;
		/** The current slowdown, or null once the window keeps up again. */
		"window:health": WindowHealthIncident | null;
	}
}
