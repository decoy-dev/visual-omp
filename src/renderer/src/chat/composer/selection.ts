import { liveEntries, pendingAsk, questionPresentation, type SessionView } from '../../state/session';

/** Everything the composer renders or uses to choose an input action. Streaming text and helper progress are not input state. */
export function composerSelection(view: SessionView) {
	const host = view.host;
	const question = questionPresentation(view);
	return {
		mode: view.mode,
		readOnly: view.readOnly,
		working: view.working,
		follow: view.follow,
		queue: view.queue,
		strandedImages: view.strandedImages,
		inputHistory: view.inputHistory,
		history: view.history,
		displayLeaf: view.displayLeaf,
		entries: liveEntries(view),
		sessionId: host?.sessionId ?? view.guest?.header?.id ?? view.history?.header?.id ?? null,
		hostId: host?.hostId ?? null,
		generation: host?.generation ?? 0,
		transport: host?.transport,
		tspAvailability: host?.tspAvailability,
		tspComposer: host?.tspComposer,
		tspEditorRestore: host?.tspEditorRestore,
		uiRequest: view.guest?.uiRequest ?? null,
		askWaiting: pendingAsk(view),
		questionPending: question.pending,
		formCallId: question.form?.toolCallId ?? null,
		awaitingAsyncWork: view.guest?.awaitingAsyncWork === true,
	};
}
