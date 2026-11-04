/** The large-chat warning dialog (DESIGN §8.4), loaded from its own chunk when a question is shown (or in idle time). */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ResumeRequest } from "../../registry/guards";
import { Button, Dialog, DialogContent } from "../../ui";
import { answerLargeResume } from "./largeResume";

export function LargeResumeDialog({ request }: { request: ResumeRequest }): ReactNode {
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

