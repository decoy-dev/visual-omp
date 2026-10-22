/**
 * What `before-quit` does with a quit (DESIGN §4.22). The renderer decides whether chats are still working, so a quit
 * waits for its answer. On macOS closing the window keeps the app and its omp processes running; a quit without a
 * window then reopens it so the renderer can ask, unless no omp is running and nothing could be interrupted.
 */
export type QuitAction =
	/** Let the quit go ahead. */
	| "proceed"
	/** Hold the quit and ask the open window (`app:quitRequested`). */
	| "ask"
	/** Hold the quit and open the window, which asks once it has loaded. */
	| "reopen"
	/** Hold the quit: a reopened window is already loading to ask. */
	| "hold";

export interface QuitState {
	/** The renderer approved quitting (or had nothing running). */
	approved: boolean;
	hasWindow: boolean;
	/** An omp process the app started is still running. */
	ompRunning: boolean;
	/** A window reopened for an earlier quit has not loaded yet. */
	reopening: boolean;
}

export function quitAction(state: QuitState): QuitAction {
	if (state.approved) return "proceed";
	// The reopened window exists from the moment it is created, but asks only once it has loaded.
	if (state.reopening) return "hold";
	if (state.hasWindow) return "ask";
	return state.ompRunning ? "reopen" : "proceed";
}
