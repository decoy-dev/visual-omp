import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { workInFlight } from "../../state/chatWork";
import type { SessionController } from "../../state/session";
import { Button, Checkbox, Dialog, DialogContent, PulseDot } from "../../ui";
import { SessionTitle } from "../../ui/SessionTitle";
import { chatTitle } from "./chat";
import { answerQuitRequest, type LostDraft, type QuitAnswer, restoreQuitFocus, stateKnown, useQuitRequest } from "./quit";
import { bulkCopy, closeCopy, quitCopy, rowCopy } from "./quitCopy";

/** One chat in the quit list, live: what it is doing now, "No work running", or "Not checked" while unknown. */
function WorkingChat({ controller }: { controller: SessionController }) {
	const { t } = useTranslation("onboarding");
	const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	const known = stateKnown(view);
	const work = known ? workInFlight(view) : null;
	const doing = known ? rowCopy(work) : { key: "quit.notChecked" };
	return (
		<li className="flex h-9 items-center gap-2.5 px-3">
			{work ? <PulseDot /> : <span className={known ? "size-2 rounded-full bg-ok" : "size-2 rounded-full bg-warn"} aria-hidden />}
			<SessionTitle title={chatTitle(controller) ?? t("notify.untitled")} className="flex-1 text-md text-fg" />
			<span className="shrink-0 text-sm text-fg-muted">{t(doing.key, { count: doing.count })}</span>
		</li>
	);
}

/** The draft text or attachments one chat would lose, under a heading naming the choice that loses them. */
function LostDrafts({ heading, drafts }: { heading: string; drafts: readonly LostDraft[] }) {
	const { t } = useTranslation("onboarding");
	if (drafts.length === 0) return null;
	return (
		<section aria-label={heading}>
			<h3 className="mb-2 text-md font-medium text-fg">{heading}</h3>
			<ul className="divide-y divide-border rounded-md border border-border bg-inset">
				{drafts.map(draft => (
					<li key={draft.tabId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
						<SessionTitle title={draft.title ?? t("notify.untitled")} className="min-w-0 flex-1 text-md text-fg" />
						<span className="text-sm text-fg-muted">{t(draft.text ? draft.attachments ? "quit.draftBoth" : "quit.draftText" : "quit.draftAttachments", { count: draft.attachments })}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

/** Mounted once at the app root. */
export function QuitDialog() {
	const { t } = useTranslation("onboarding");
	const request = useQuitRequest(state => state.request);
	const [alwaysStop, setAlwaysStop] = useState(false);
	if (!request) return null;
	const tab = request.kind === "tab";
	const scope = request.kind === "bulk" ? request.scope : null;
	const offerIdle = request.idleDrafts != null;
	const first = request.chats[0];
	const work = request.chats.map(chat => chat.work);
	const copy = scope
		? bulkCopy(scope, work, request.unchecked.length, request.count ?? 0, offerIdle)
		: tab && first ? closeCopy(first.work) : quitCopy(work, request.unchecked.length);
	const confirmKey = scope === "all" ? "quit.allConfirm" : scope === "selected" ? "quit.selectedConfirm" : scope === "idle" ? "quit.idleConfirm" : tab ? "quit.stopAndClose" : "quit.stopAndQuit";

	const answer = (choice: QuitAnswer) => {
		setAlwaysStop(false);
		answerQuitRequest(choice, alwaysStop);
	};

	return (
		<Dialog open onOpenChange={open => !open && answer(false)}>
			<DialogContent
				onCloseAutoFocus={event => { event.preventDefault(); restoreQuitFocus(request); }}
				size={offerIdle ? "md" : "sm"}
				destructive
				hideClose
				title={t(copy.title.key, { count: copy.title.count })}
				description={copy.body.map(part => t(part.key, { count: part.count })).join(" ")}
				footer={
					<>
						<Button variant="ghost" onClick={() => answer(false)} autoFocus>
							{t(scope ? "quit.cancel" : "quit.keepWaiting")}
						</Button>
						{offerIdle && (
							<Button variant="secondary" onClick={() => answer("idle")}>
								{t("quit.idleConfirm")}
							</Button>
						)}
						<Button variant="danger" onClick={() => answer(true)}>
							{t(confirmKey)}
						</Button>
					</>
				}
			>
				{!tab && (
					<>
						{scope !== "idle" && (request.chats.length > 0 || request.unchecked.length > 0) && (
							<ul className="mb-4 divide-y divide-border rounded-md border border-border bg-inset">
								{[...request.chats.map(chat => chat.controller), ...request.unchecked].map(controller => (
									<WorkingChat key={controller.tabId} controller={controller} />
								))}
							</ul>
						)}
						{scope ? (
							offerIdle ? (
								<div className="flex flex-col gap-4">
									<LostDrafts heading={t("quit.draftsLostIdle")} drafts={request.idleDrafts!} />
									<LostDrafts heading={t(scope === "all" ? "quit.draftsLostAll" : "quit.draftsLostSelected")} drafts={request.drafts ?? []} />
								</div>
							) : (
								<LostDrafts heading={t("quit.draftsLost")} drafts={request.drafts ?? []} />
							)
						) : (
							<Checkbox label={t("quit.dontAsk")} checked={alwaysStop} onCheckedChange={setAlwaysStop} />
						)}
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
