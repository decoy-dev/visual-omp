/**
 * The large-chat warning (DESIGN §8.4). Before omp resumes a saved chat whose file is at least `LARGE_RESUME_BYTES`,
 * `SessionController` asks through the resume guard: resume it, start a new chat in the same folder instead, or
 * cancel. Requests from several chats are answered one at a time, and a chat that closes while it waits answers no.
 * `index.ts` loads this module on the first question (or in idle time), so none of it is in the initial renderer chunk.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { i18n } from "../../i18n";
import { isResumeDeclined, type ResumeRequest } from "../../registry/guards";
import { useApp } from "../../state/app";
import { Button, Dialog, DialogContent } from "../../ui";
import { toast } from "../../ui/toast";

export type ResumeChoice = "resume" | "new-chat" | "cancel";

interface PendingResume {
	request: ResumeRequest;
	resolve(choice: ResumeChoice): void;
}

/** The request the dialog shows (exported for tests). */
export const useLargeResume = create<{ pending: PendingResume | null }>(() => ({ pending: null }));

/** Requests waiting behind the one shown, oldest first. */
const waiting: PendingResume[] = [];

function settle(entry: PendingResume, choice: ResumeChoice): void {
	const index = waiting.indexOf(entry);
	if (index >= 0) waiting.splice(index, 1);
	if (useLargeResume.getState().pending === entry) useLargeResume.setState({ pending: waiting.shift() ?? null });
	entry.resolve(choice);
}

/** Answer the dialog that is showing. */
export function answerLargeResume(choice: ResumeChoice): void {
	const pending = useLargeResume.getState().pending;
	if (pending) settle(pending, choice);
}

async function startNewChat(projectPath: string): Promise<void> {
	try {
		await useApp.getState().newChat(projectPath);
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
	const { promise, resolve } = Promise.withResolvers<ResumeChoice>();
	const entry: PendingResume = { request, resolve };
	const abort = () => settle(entry, "cancel");
	request.signal.addEventListener("abort", abort, { once: true });
	if (useLargeResume.getState().pending) waiting.push(entry);
	else useLargeResume.setState({ pending: entry });
	const choice = await promise;
	request.signal.removeEventListener("abort", abort);
	if (choice === "new-chat") void startNewChat(request.projectPath);
	return choice === "resume";
}

function LargeResumeDialog({ request }: { request: ResumeRequest }): ReactNode {
	const { t, i18n: active } = useTranslation("session");
	// Intl's megabyte unit is decimal, so the figure is bytes divided by 1,000,000.
	const size = new Intl.NumberFormat(active.language, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(request.bytes / 1_000_000);
	return (
		<Dialog open onOpenChange={open => !open && answerLargeResume("cancel")}>
			<DialogContent
				size="sm"
				hideClose
				title={t("largeResume.title")}
				description={t("largeResume.risk", { size })}
				footer={
					// Three actions can outgrow the 400px dialog at larger text sizes, so they wrap instead of shrinking.
					<div className="flex min-w-0 flex-1 flex-wrap justify-end gap-2">
						<Button variant="ghost" onClick={() => answerLargeResume("cancel")} autoFocus>
							{t("common.cancel")}
						</Button>
						<Button variant="secondary" onClick={() => answerLargeResume("new-chat")}>
							{t("largeResume.newChat")}
						</Button>
						<Button variant="primary" onClick={() => answerLargeResume("resume")}>
							{t("largeResume.resume")}
						</Button>
					</div>
				}
			>
				<p className="text-fg-muted">{t("largeResume.newChatNote")}</p>
			</DialogContent>
		</Dialog>
	);
}

/** Mounted once at the app root. */
export function LargeResumeHost(): ReactNode {
	const pending = useLargeResume(state => state.pending);
	return pending ? <LargeResumeDialog key={pending.request.tabId} request={pending.request} /> : null;
}
