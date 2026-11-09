/**
 * The large-chat warning (DESIGN §8.4). Before omp resumes a saved chat whose file is at least `LARGE_RESUME_BYTES`,
 * `SessionController` asks through the resume guard: resume it, start a new chat in the same folder instead, or
 * cancel. Requests from several chats are answered one at a time, and a chat that closes while it waits answers no.
 * The questions and their host load with the app; the dialog (`./LargeResumeDialog`) loads from its own chunk on the
 * first question or in idle time, and if it does not load, its failure dialog's Close answers no.
 */
import type { ReactNode } from "react";
import { create } from "zustand";
import { i18n } from "../../i18n";
import { isResumeDeclined, type ResumeRequest } from "../../registry/guards";
import { LoadFailedDialog, type LoadFailureProps, lazyView } from "../../registry/lazy";
import { useApp } from "../../state/app";
import { toast } from "../../ui/toast";

export type ResumeChoice = "resume" | "new-chat" | "cancel";

interface PendingResume {
	request: ResumeRequest;
	resolve(choice: { action: ResumeChoice; handoff: boolean }): void;
}

/** The request the dialog shows (exported for tests). */
export const useLargeResume = create<{ pending: PendingResume | null }>(() => ({ pending: null }));

/** Requests waiting behind the one shown, oldest first. */
const waiting: PendingResume[] = [];

function settle(entry: PendingResume, choice: { action: ResumeChoice; handoff: boolean }): void {
	const index = waiting.indexOf(entry);
	if (index >= 0) waiting.splice(index, 1);
	if (useLargeResume.getState().pending === entry) useLargeResume.setState({ pending: waiting.shift() ?? null });
	entry.resolve(choice);
}

/** Answer the dialog that is showing. */
export function answerLargeResume(action: ResumeChoice, handoff = true): void {
	const pending = useLargeResume.getState().pending;
	if (pending) settle(pending, { action, handoff });
}

async function startNewChat(request: ResumeRequest, handoff: boolean): Promise<void> {
	try {
		if (handoff) {
			// Keep the transfer controller and its row outside the initial renderer graph, like the warning dialog.
			const { startLargeHandoff } = await import("./largeHandoff");
			await startLargeHandoff(request);
		} else await useApp.getState().newChat(request.projectPath);
	} catch (error) {
		toast({ tone: "err", message: i18n.t("session:largeResume.newChatFailed"), description: error instanceof Error ? error.message : String(error) });
	}
}

let droppingDeclines = false;

/** The resume guard: resolves true when omp may resume the chat. Start new chat opens it here and answers no. */
export async function askLargeResume(request: ResumeRequest): Promise<boolean> {
	if (!droppingDeclines) {
		droppingDeclines = true;
		// Callers that start omp without awaiting it (a banner button, a menu item) would report a declined warning as an
		// unhandled rejection. Only that rejection is dropped, and no decline can happen before this first question.
		window.addEventListener("unhandledrejection", event => {
			if (isResumeDeclined(event.reason)) event.preventDefault();
		});
	}
	if (request.signal.aborted) return false;
	const { promise, resolve } = Promise.withResolvers<{ action: ResumeChoice; handoff: boolean }>();
	const entry: PendingResume = { request, resolve };
	const abort = () => settle(entry, { action: "cancel", handoff: false });
	request.signal.addEventListener("abort", abort, { once: true });
	if (useLargeResume.getState().pending) waiting.push(entry);
	else useLargeResume.setState({ pending: entry });
	const choice = await promise;
	request.signal.removeEventListener("abort", abort);
	if (choice.action === "new-chat" && !request.signal.aborted) await startNewChat(request, choice.handoff);
	return choice.action === "resume";
}

/** The dialog loads from its own chunk; if it does not load, the failure dialog's Close answers no. */
function LargeResumeDialogFailed({ retry }: LoadFailureProps): ReactNode {
	return <LoadFailedDialog retry={retry} onClose={() => answerLargeResume("cancel")} />;
}
const LargeResumeDialog = lazyView(() => import("./LargeResumeDialog").then(module => module.LargeResumeDialog), null, LargeResumeDialogFailed);

/** Mounted once at the app root: the question being asked, if any. */
export function LargeResumeHost(): ReactNode {
	const pending = useLargeResume(state => state.pending);
	return pending ? <LargeResumeDialog key={pending.request.tabId} request={pending.request} /> : null;
}
