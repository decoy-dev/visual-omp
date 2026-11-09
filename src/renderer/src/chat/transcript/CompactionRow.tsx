import type { CompactionEntry } from "@oh-my-pi/pi-wire";
import { CaretRight, Copy } from "@phosphor-icons/react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../../transcript/Markdown";
import { cn, Expand, IconButton, toast } from "../../ui";
import { TranscriptTime } from "./TranscriptTime";

/**
 * Where omp replaced earlier context with a summary (DESIGN §4.6). The divider names what happened: "Handed off"
 * for /handoff (omp records `method: "handoff"`) and "Context summarized" for compaction. Opening it shows the
 * document omp now continues from, which omp keeps in this chat, with Copy. A handoff that arrives while the chat
 * is open starts open, so the person who ran /handoff sees the result; summaries start closed.
 */
export function CompactionRow({ entry, arrived = false }: { entry: CompactionEntry; arrived?: boolean }): ReactNode {
	const { t } = useTranslation("chat");
	const kind = entry.method === "handoff" ? "handoff" : "summary";
	const [open, setOpen] = useState(arrived && kind === "handoff");
	const summary = entry.summary.trim();
	const panel = useId();
	return (
		<div className="flex flex-col">
			<div className="flex items-center gap-3 py-1 text-xs text-fg-faint" role="note">
				<span className="h-px flex-1 bg-border" />
				{summary ? (
					<button
						type="button"
						aria-expanded={open}
						aria-controls={panel}
						onClick={() => setOpen(value => !value)}
						className="-mx-2 flex h-7 items-center gap-1.5 rounded-md px-2 outline-none transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg-muted focus-visible:outline-2 focus-visible:outline-ring"
					>
						<CaretRight className={cn("size-3 transition-[rotate] duration-(--dur) ease-(--ease-out)", open && "rotate-90")} aria-hidden />
						{t(`compaction.${kind}.label`)}
						<TranscriptTime timestamp={entry.timestamp} className="ml-1" inControl />
					</button>
				) : (
					<span className="flex items-center gap-2">{t(`compaction.${kind}.label`)}<TranscriptTime timestamp={entry.timestamp} /></span>
				)}
				<span className="h-px flex-1 bg-border" />
			</div>
			<Expand open={open && !!summary} id={panel}>
				<div className="mt-1 mb-2 flex flex-col gap-3 rounded-lg border border-border bg-inset px-4 py-3">
					<div className="flex items-start gap-3">
						<p className="flex-1 text-sm text-fg-muted">{t(`compaction.${kind}.explain`)}</p>
						<IconButton
							label={t(`compaction.${kind}.copy`)}
							icon={<Copy />}
							size="sm"
							onClick={() => void navigator.clipboard.writeText(summary).then(() => toast({ tone: "ok", message: t("copied") }))}
						/>
					</div>
					<div className="selectable min-w-0 text-sm [overflow-wrap:anywhere]">
						<Markdown text={summary} />
					</div>
				</div>
			</Expand>
		</div>
	);
}
