import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { workInFlight } from "../../state/chatWork";
import type { SessionController } from "../../state/session";
import { Button, Checkbox, Dialog, DialogContent, PulseDot } from "../../ui";
import { SessionTitle } from "../../ui/SessionTitle";
import { chatTitle } from "./chat";
import { answerQuitRequest, restoreQuitFocus, stateKnown, useQuitRequest } from "./quit";
import { closeAllCopy, closeCopy, quitCopy, rowCopy } from "./quitCopy";

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

/** Mounted once at the app root. */
export function QuitDialog() {
	const { t } = useTranslation("onboarding");
	const request = useQuitRequest(state => state.request);
	const [alwaysStop, setAlwaysStop] = useState(false);
	if (!request) return null;
	const tab = request.kind === "tab";
	const all = request.kind === "all";
	const first = request.chats[0];
	const copy =
		all ? closeAllCopy(request.chats.map(chat => chat.work), request.unchecked.length) : tab && first
			? closeCopy(first.work)
			: quitCopy(
					request.chats.map(chat => chat.work),
					request.unchecked.length,
				);

	const answer = (allow: boolean) => {
		setAlwaysStop(false);
		answerQuitRequest(allow, alwaysStop);
	};

	return (
		<Dialog open onOpenChange={open => !open && answer(false)}>
			<DialogContent
				onCloseAutoFocus={event => { event.preventDefault(); restoreQuitFocus(request); }}
				size="sm"
				destructive
				hideClose
				title={t(copy.title.key, { count: copy.title.count })}
				description={copy.body.map(part => t(part.key, { count: part.count })).join(" ")}
				footer={
					<>
						<Button variant="ghost" onClick={() => answer(false)} autoFocus>
							{t(all ? "quit.cancel" : "quit.keepWaiting")}
						</Button>
						<Button variant="danger" onClick={() => answer(true)}>
							{t(all ? "quit.allConfirm" : tab ? "quit.stopAndClose" : "quit.stopAndQuit")}
						</Button>
					</>
				}
			>
				{!tab && (
					<>
						{(request.chats.length > 0 || request.unchecked.length > 0) && (
							<ul className="mb-4 divide-y divide-border rounded-md border border-border bg-inset">
								{[...request.chats.map(chat => chat.controller), ...request.unchecked].map(controller => (
									<WorkingChat key={controller.tabId} controller={controller} />
								))}
							</ul>
						)}
						{all ? (
							(request.drafts?.length ?? 0) > 0 && (
								<section aria-label={t("quit.draftsLost")}>
									<h3 className="mb-2 text-md font-medium text-fg">{t("quit.draftsLost")}</h3>
									<ul className="divide-y divide-border rounded-md border border-border bg-inset">
										{request.drafts!.map(draft => (
											<li key={draft.tabId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
												<SessionTitle title={draft.title ?? t("notify.untitled")} className="min-w-0 flex-1 text-md text-fg" />
												<span className="text-sm text-fg-muted">{t(draft.text ? draft.attachments ? "quit.draftBoth" : "quit.draftText" : "quit.draftAttachments", { count: draft.attachments })}</span>
											</li>
										))}
									</ul>
								</section>
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
