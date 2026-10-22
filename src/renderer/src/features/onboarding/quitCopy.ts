/**
 * Which `onboarding:quit.*` strings the quit and close warnings show (DESIGN §8.4). They state the work recorded when
 * the user chose to quit or close (omp's reply, helpers at work, or both, in one message), since that work may end
 * while the dialog is open; the quit list's rows show each chat as it is now.
 */
import type { ChatWork } from "../../state/chatWork";

/** An i18n key with the count its plural forms take, when it has them. */
export interface CopyKey {
	key: string;
	count?: number;
}

/** A title, and a body made of sentences joined by spaces. */
export interface WarningCopy {
	title: CopyKey;
	body: CopyKey[];
}

/** The warning for closing one chat, from the work recorded when the user chose to close it. */
export function closeCopy(work: ChatWork): WarningCopy {
	if (work.helpers === 0) return { title: { key: "quit.tabReplyTitle" }, body: [{ key: "quit.tabReplyBody" }] };
	if (!work.replying) return { title: { key: "quit.tabHelpersTitle" }, body: [{ key: "quit.tabHelpersBody", count: work.helpers }] };
	return { title: { key: "quit.tabBothTitle" }, body: [{ key: "quit.tabBothBody", count: work.helpers }] };
}

/**
 * The warning for quitting, from the work recorded when the user chose to quit: chats where omp was replying, helpers
 * working, and chats whose state could not be checked in time.
 */
export function quitCopy(work: readonly ChatWork[], unchecked: number): WarningCopy {
	const replies = work.filter(chat => chat.replying).length;
	const helpers = work.reduce((total, chat) => total + chat.helpers, 0);
	const body: CopyKey[] = [];
	if (replies > 0) body.push({ key: "quit.bodyReplies", count: replies });
	if (helpers > 0) body.push({ key: replies > 0 ? "quit.bodyHelpersToo" : "quit.bodyHelpers", count: helpers });
	if (unchecked > 0) body.push({ key: "quit.bodyUnchecked", count: unchecked });
	body.push({ key: "quit.bodyEnd" });
	return { title: { key: work.length > 0 ? "quit.title" : "quit.titleUnchecked" }, body };
}

/** What one chat in the quit list is doing now; its work may have ended while the dialog was open. */
export function rowCopy(work: ChatWork | null): CopyKey {
	if (!work) return { key: "quit.noWork" };
	if (work.helpers === 0) return { key: "quit.working" };
	return { key: work.replying ? "quit.rowBoth" : "quit.rowHelpers", count: work.helpers };
}
