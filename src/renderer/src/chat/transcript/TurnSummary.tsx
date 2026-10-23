/**
 * The foot of a finished turn: the files omp edited or wrote in it, with edit totals summed from omp's own edit
 * results (never from git, so a user's own changes never show here) and git-style proportional bars. One click opens
 * the file list; "Review changes" opens the Changes pane. Files whose counts omp did not report show no numbers.
 */
import { CaretRight, GitDiff } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { relativePath } from "../../features/panes/common";
import type { EditTotals, FileEditTotal } from "../../features/panes/derive";
import { useApp } from "../../state/app";
import { Button, cn, Definition, Expand } from "../../ui";

const SEGMENTS = 5;

/** Five squares split into added and removed, like `git diff --stat`; `filled` of them carry color. */
function DiffBar({ added, removed, filled }: { added: number; removed: number; filled: number }): ReactNode {
	const total = added + removed;
	const adds = total === 0 ? 0 : Math.round((filled * added) / total);
	const cells = Array.from({ length: SEGMENTS }, (_, index) => (index < adds ? "add" : index < filled ? "del" : "none"));
	return (
		<span aria-hidden className="inline-flex shrink-0 gap-px">
			{cells.map((cell, index) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed cells
					key={index}
					className={cn("h-2.5 w-1.5", cell === "add" ? "bg-diff-add-text" : cell === "del" ? "bg-diff-del-text" : "bg-border-strong")}
				/>
			))}
		</span>
	);
}

function Counts({ added, removed }: { added: number; removed: number }): ReactNode {
	return (
		<span className="shrink-0 font-mono text-sm tabular-nums">
			<span className="text-diff-add-text">+{added}</span> <span className="text-diff-del-text">−{removed}</span>
		</span>
	);
}

function FileRow({ file, projectPath, scale, onOpen }: { file: FileEditTotal; projectPath: string; scale: number; onOpen(path: string): void }): ReactNode {
	const { t } = useTranslation("panes");
	const shown = relativePath(projectPath, file.path);
	const slash = shown.lastIndexOf("/");
	const total = (file.added ?? 0) + (file.removed ?? 0);
	return (
		<li>
			<button
				type="button"
				data-context-path={file.path}
				data-context-changes=""
				onClick={() => onOpen(file.path)}
				title={file.path}
				className="flex h-8 w-full items-center gap-3 rounded-sm px-2 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			>
				<span className="min-w-0 flex-1 truncate font-mono text-sm">
					{slash >= 0 && <span className="text-fg-faint">{shown.slice(0, slash + 1)}</span>}
					<span className="text-fg">{shown.slice(slash + 1)}</span>
				</span>
				{file.action !== "edited" && <span className="shrink-0 text-xs text-fg-faint">{t(`work.summary.action.${file.action}`)}</span>}
				{file.added !== null && file.removed !== null && (
					<>
						<Counts added={file.added} removed={file.removed} />
						<DiffBar added={file.added} removed={file.removed} filled={total === 0 ? 0 : Math.max(1, Math.round((SEGMENTS * total) / scale))} />
					</>
				)}
			</button>
		</li>
	);
}

export function TurnSummary({ totals, projectPath, tabId, onOpen }: { totals: EditTotals; projectPath: string; tabId: string; onOpen(path: string): void }): ReactNode {
	const { t } = useTranslation("panes");
	const [open, setOpen] = useState(false);
	const counted = totals.files.some(file => file.added !== null);
	const scale = Math.max(1, ...totals.files.map(file => (file.added ?? 0) + (file.removed ?? 0)));
	const definition = totals.partial ? t("work.summary.totalsHintPartial") : t("work.summary.totalsHint");
	return (
		<div className="group/summary">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen(value => !value)}
					className="-mx-2 flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
				>
					<GitDiff className="size-4 shrink-0 text-fg-faint" aria-hidden />
					<span className="min-w-0 truncate text-md text-fg-muted group-hover/summary:text-fg">{t("work.summary.files", { count: totals.files.length })}</span>
					<CaretRight className={cn("size-3.5 shrink-0 text-fg-faint transition-[rotate] duration-(--dur) ease-(--ease-out)", open && "rotate-90")} aria-hidden />
				</button>
				{counted && (
					<span className="flex min-w-0 items-center gap-2">
						<Definition content={definition} className="text-sm text-fg-faint">
							{totals.partial ? t("work.summary.totalsPartial") : t("work.summary.totals")}
						</Definition>
						<Counts added={totals.added} removed={totals.removed} />
						<DiffBar added={totals.added} removed={totals.removed} filled={totals.added + totals.removed === 0 ? 0 : SEGMENTS} />
					</span>
				)}
			</div>
			<Expand open={open} className="pt-2">
				<div className="rounded-lg border border-border bg-panel p-menu">
					<div className="flex flex-wrap items-center gap-x-2 px-row py-1">
						<p className="min-w-0 flex-[1_1_12rem] text-sm font-semibold text-fg">{t("work.summary.title")}</p>
						<Button variant="ghost" size="sm" icon={<GitDiff />} onClick={() => useApp.getState().showPane("diff", tabId)}>
							{t("work.summary.review")}
						</Button>
					</div>
					<ul className="flex flex-col">
						{totals.files.map(file => (
							<FileRow key={file.path} file={file} projectPath={projectPath} scale={scale} onOpen={onOpen} />
						))}
					</ul>
				</div>
			</Expand>
		</div>
	);
}
