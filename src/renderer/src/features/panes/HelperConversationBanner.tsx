import { ArrowLeft } from "@phosphor-icons/react";
import { sessionTitleText } from "@shared/titleCard";
import { type ReactNode, type Ref, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, StatusDot } from "../../ui";
import type { Helper } from "./derive";
import { HelperIdentity } from "./HelperIdentity";

/** Kept outside the lazy boundary so loading and ready headers cannot announce the same opening twice. */
export function HelperConversationAnnouncement({ helper, parentTitle }: { helper: Helper; parentTitle: string }): ReactNode {
	const { t } = useTranslation("panes");
	const [announcement, setAnnouncement] = useState("");
	// biome-ignore lint/correctness/useExhaustiveDependencies: announce entry once per helper, without repeating progress or title updates.
	useEffect(() => {
		setAnnouncement(t("tasks.conversation.announcement", { name: helper.name, title: sessionTitleText(parentTitle), status: t(`tasks.helperStatus.${helper.status}`) }));
	}, [helper.id]);
	return <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>;
}
/** Shared by the loaded conversation and its lazy boundary, so the destination remains explicit throughout. */
export function HelperConversationBanner({ helper, parentTitle, onBack, backRef, autoFocus = false }: {
	helper: Helper;
	parentTitle: string;
	onBack(): void;
	backRef?: Ref<HTMLButtonElement>;
	autoFocus?: boolean;
}): ReactNode {
	const { t } = useTranslation("panes");
	const heading = useId();
	const title = sessionTitleText(parentTitle);
	return (
		<header data-helper-banner aria-labelledby={heading} className="@container/helper-banner shrink-0 bg-accent text-accent-fg">
			<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-toolbar px-page py-stack @min-[36rem]/helper-banner:grid-cols-[auto_minmax(0,1fr)_auto]">
				<div className="col-span-2 min-w-0 @min-[36rem]/helper-banner:col-span-1">
					<Button ref={backRef} autoFocus={autoFocus} size="md" variant="secondary" icon={<ArrowLeft />} onClick={onBack}
						aria-label={t("tasks.conversation.backNamed", { title })} title={t("tasks.conversation.backNamed", { title })}
						className="max-w-full justify-start [--ring:var(--accent-fg)] [&>span]:min-w-0 @min-[36rem]/helper-banner:max-w-64">
						<span className="inline-flex min-w-0"><span className="shrink-0 whitespace-pre">{t("tasks.conversation.back")} </span><span className="min-w-0 truncate">{title}</span></span>
					</Button>
				</div>
				<div className="col-span-2 flex min-w-0 items-start gap-toolbar @min-[36rem]/helper-banner:col-span-1">
					<HelperIdentity helper={helper} />
					<div className="min-w-0 flex-1">
						<h2 id={heading} className="text-md font-semibold [overflow-wrap:anywhere]">{t("tasks.conversation.title", { name: helper.name })}</h2>
						<p title={t("tasks.conversation.parent", { title })} className="mt-1 truncate text-sm">{t("tasks.conversation.parent", { title })}</p>
					</div>
				</div>
				<div className="flex items-center justify-self-start gap-1.5 rounded-md bg-panel px-row py-1 text-sm text-fg">
					<StatusDot glyph showLabel className="text-sm text-fg" status={helper.status === "running" ? "agent" : helper.status === "failed" ? "err" : helper.status === "done" ? "ok" : "idle"} label={t(`tasks.helperStatus.${helper.status}`)} />
				</div>
			</div>
		</header>
	);
}
