/**
 * "Reopen closed chat" (⌘⇧T): a short stack of chats closed in this window, newest first. Only chats with a saved
 * session file go on it, with the text left in their message box. Reopening shows the saved chat and its draft
 * without starting omp.
 */

export interface ClosedChat {
	projectPath: string;
	sessionFile: string;
	title: string | null;
	/** Unsent message text when the chat closed. */
	draft: string;
}

/** Closed chats kept for reopening. */
export const CLOSED_LIMIT = 10;

/** `stack` with `chat` on top; an older entry for the same file is dropped and the oldest fall off past the limit. */
export function pushClosed(stack: readonly ClosedChat[], chat: ClosedChat): ClosedChat[] {
	return [chat, ...stack.filter(entry => entry.sessionFile !== chat.sessionFile)].slice(0, CLOSED_LIMIT);
}

/**
 * The newest closed chat that can come back: not open again already and its file still on disk. `skipped` lists
 * the newer entries passed over on the way, which the caller drops from the stack with the one it reopens.
 */
export async function takeReopenable(
	stack: readonly ClosedChat[],
	isOpen: (sessionFile: string) => boolean,
	exists: (sessionFile: string) => Promise<boolean>,
): Promise<{ chat: ClosedChat | null; skipped: ClosedChat[] }> {
	const skipped: ClosedChat[] = [];
	for (const entry of stack) {
		if (!isOpen(entry.sessionFile) && (await exists(entry.sessionFile))) return { chat: entry, skipped };
		skipped.push(entry);
	}
	return { chat: null, skipped };
}
