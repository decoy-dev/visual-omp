/** The large-chat warning dialog (DESIGN §8.4), loaded from its own chunk when a question is shown (or in idle time). */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { composerText, useComposerDrafts } from "../../chat/composer/drafts";
import type { ResumeRequest } from "../../registry/guards";
import { Button, Checkbox, Dialog, DialogContent } from "../../ui";
import { answerLargeResume } from "./largeResume";

export function LargeResumeDialog({ request }: { request: ResumeRequest }): ReactNode {
	const { t, i18n: active } = useTranslation("session");
	const [handoff, setHandoff] = useState(true);
	const draftPresent = useComposerDrafts(state => !!composerText(state, request.tabId).trim() || !!state.attachments[request.tabId]?.length);
	const hasMessage = request.message ? !!request.message.text.trim() || request.message.images.length > 0 : draftPresent;
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
						<Button variant="secondary" onClick={() => answerLargeResume("new-chat", handoff)}>
							{t("largeResume.newChat")}
						</Button>
						<Button variant="primary" onClick={() => answerLargeResume("resume")}>
							{t("largeResume.resume")}
						</Button>
					</div>
				}
			>
				<div className="space-y-3">
					<p className="text-fg-muted">{t(handoff ? hasMessage ? "largeResume.handoffNote" : "largeResume.handoffOnlyNote" : "largeResume.newChatNote")}</p>
					<Checkbox checked={handoff} onCheckedChange={setHandoff} label={t(hasMessage ? "largeResume.bringMessage" : "largeResume.bringHandoff")} />
				</div>
			</DialogContent>
		</Dialog>
	);
}

