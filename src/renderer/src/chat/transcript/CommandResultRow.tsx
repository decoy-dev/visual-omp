/**
 * What omp printed for a typed slash command (DESIGN §3.5 "Command results"): a tool-style row with the
 * command, and omp's lines in a monospace well below it, cut to a few lines with a control to show
 * all. Warnings and errors tone the row's icon. Ephemeral: dismissable and never saved.
 */
import { TerminalWindow, Warning, X, XCircle } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CommandResultRecord } from "../../features/session-tools/results";
import { cn, IconButton } from "../../ui";

/** Longer output starts cut to this many lines. */
const COLLAPSED_LINES = 12;

const TONE_ICON = { info: TerminalWindow, warn: Warning, err: XCircle };
const TONE_CLASS = { info: "text-fg-faint", warn: "text-warn", err: "text-err" };

export function CommandResultRow({ result, onDismiss }: { result: CommandResultRecord; onDismiss: () => void }): ReactNode {
	const { t } = useTranslation("session");
	const [open, setOpen] = useState(false);
	const long = result.lines.length > COLLAPSED_LINES;
	const shown = open || !long ? result.lines : result.lines.slice(0, COLLAPSED_LINES);
	const ToneIcon = TONE_ICON[result.tone];
	return (
		<section aria-label={t("commandResult.aria", { command: result.command })} className="group/result flex flex-col">
			<div className="-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2">
				<ToneIcon className={cn("size-4 shrink-0", TONE_CLASS[result.tone])} aria-hidden />
				<span className="selectable min-w-0 flex-1 truncate font-mono text-sm text-fg-muted">{result.command}</span>
				<IconButton
					label={t("commandResult.dismiss")}
					icon={<X />}
					size="sm"
					className="opacity-0 transition-opacity duration-(--dur) group-hover/result:opacity-100 group-focus-within/result:opacity-100"
					onClick={onDismiss}
				/>
			</div>
			<div className="pb-1 pl-6.5">
				<pre className="selectable max-h-96 overflow-auto rounded-md bg-inset px-3 py-2 font-mono text-code whitespace-pre text-fg-muted">
					{shown.join("\n")}
				</pre>
				{long && (
					<button
						type="button"
						aria-expanded={open}
						onClick={() => setOpen(value => !value)}
						className="mt-1 rounded-sm text-sm font-medium text-fg-muted outline-none transition-colors duration-(--dur-fast) hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						{open ? t("commandResult.less") : t("commandResult.more", { count: result.lines.length })}
					</button>
				)}
			</div>
		</section>
	);
}
