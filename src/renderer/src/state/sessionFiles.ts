import type { FollowState } from "@shared/ipc";
import { extendSessionHistory, parseSessionHistory, type SessionHistory } from "./history";

interface Reader {
	history: SessionHistory | null;
	state: FollowState | null;
	listeners: Set<(history: SessionHistory | null, state: FollowState | null) => void>;
	off(): void;
}
const readers = new Map<string, Reader>();

/** One main-owned tail per file, shared by saved chats and helper focus views, including the initial reset. */
export function watchSessionFile(file: string, listener: (history: SessionHistory | null, state: FollowState | null) => void): () => void {
	let reader = readers.get(file);
	if (!reader) {
		const current: Reader = { history: null, state: null, listeners: new Set(), off: () => {} };
		const publish = () => { for (const notify of current.listeners) notify(current.history, current.state); };
		const offTail = window.vomp.on("sessions:tail", tail => {
			if (tail.file !== file) return;
			const history = tail.reset ? parseSessionHistory(tail.text) : current.history ? extendSessionHistory(current.history, tail.text) : null;
			if (history === current.history) return;
			current.history = history;
			publish();
		});
		const offState = window.vomp.on("sessions:followState", state => {
			if (state.file !== file) return;
			current.state = state;
			publish();
		});
		current.off = () => { offTail(); offState(); };
		readers.set(file, current);
		reader = current;
		void window.vomp.invoke("sessions:follow", [...readers.keys()]).catch(error => {
			if (readers.get(file) !== current) return;
			current.state = { file, readable: false, ownership: "unknown", error: String(error) };
			publish();
		});
	}
	reader.listeners.add(listener);
	listener(reader.history, reader.state);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		reader.listeners.delete(listener);
		if (reader.listeners.size > 0) return;
		reader.off();
		readers.delete(file);
		void window.vomp.invoke("sessions:follow", [...readers.keys()]).catch(() => undefined);
	};
}
