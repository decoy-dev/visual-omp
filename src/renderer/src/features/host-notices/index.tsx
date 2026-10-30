import { ClockCounterClockwise, Warning } from "@phosphor-icons/react";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hostNotices, latestMessageAt } from "../../chat/transcript/notices";
import { chatSlots, type ChatSlotProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { liveEntries, liveGuest } from "../../state/session";
import { cn } from "../../ui";

export function HostNotices({ session }: ChatSlotProps): ReactNode {
	const { t } = useTranslation("chat");
	const view = useSessionView(session);
	// Every branch and a reply still streaming count, so a recap stays superseded after a rewind.
	const all = liveEntries(view) ?? view?.history?.all ?? null;
	const streamingAt = liveGuest(view)?.stream?.timestamp ?? null;
	const lastMessageAt = useMemo(() => latestMessageAt(all, typeof streamingAt === "number" ? streamingAt : null), [all, streamingAt]);
	const notices = hostNotices(view?.host?.notices, lastMessageAt);
	const status = view?.host?.programStatus;
	return <div className="flex flex-col gap-3">
		{notices.map(notice => <div key={notice.id} role="note" className={cn("flex items-start gap-2 text-sm", notice.kind === "startup" ? "text-warn" : "text-fg-muted")}>
			{notice.kind === "startup" ? <Warning aria-hidden className="mt-0.5 size-4 shrink-0" /> : <ClockCounterClockwise aria-hidden className="mt-0.5 size-4 shrink-0" />}
			<p className="selectable min-w-0 whitespace-pre-wrap break-words"><span className="font-medium">{t(`hostNotices.${notice.kind}`)}: </span>{notice.text}</p>
		</div>)}
		{status?.state === "error" && status.msg && <p role="alert" className="selectable flex items-start gap-2 text-sm text-err"><Warning aria-hidden className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 break-words">{status.msg}</span></p>}
	</div>;
}

chatSlots.register({ id: "host-notices", placement: "transcriptEnd", order: 5, component: HostNotices });
