/**
 * omp's harness notices in the transcript, presented the way omp's TUI presents them (see `notices.ts`) in this
 * app's tool-row and card language: background jobs and process exits as tool steps, IRC messages and advisor notes
 * as cards, a skill invocation as a compact row on the user's side. Nothing here shows omp's model-facing wrapper.
 */
import {
	BookOpenText,
	CaretRight,
	ChatCircleText,
	Check,
	type Icon,
	Info,
	Lightbulb,
	Minus,
	Robot,
	TerminalWindow,
	X,
} from "@phosphor-icons/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fmtDuration } from "../../collab/lib/format";
import { commandSummary } from "../../features/panes/derive";
import { Markdown } from "../../transcript/Markdown";
import { cn, Expand, StatusBadge, type StatusBadgeTone } from "../../ui";
import {
	type AdvisorSeverity,
	contentText,
	fenced,
	firstLine,
	ircTitle,
	type JobNotice,
	type JobStatus,
	jobPayload,
	jobTitle,
	type Notice,
	type NoticeSource,
	parseNotice,
	processText,
} from "./notices";
import type { TranscriptMode } from "./Transcript";

/** ToolCard's row geometry; `rowInteractive` adds its hover and focus. */
const rowClass = "-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 text-left";
const rowInteractive =
	"outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
const cardClass = "rounded-lg border border-border bg-panel px-card py-3";
/** The expanded well under a step row, indented to the row's text. */
const wellIndent = "selectable pt-1 pb-3 pl-6.5";

/** A settled job's mark: check, cross or stop. The Tasks pane's background jobs use it too, so both read alike. */
export function StatusGlyph({ status }: { status: JobStatus }): ReactNode {
	const { t } = useTranslation("chat");
	if (status === "failed") {
		return (
			<span className="inline-flex size-4 shrink-0 items-center justify-center text-err" role="img" aria-label={t("notice.failed")}>
				<X weight="bold" className="size-3.5" aria-hidden />
			</span>
		);
	}
	if (status === "stopped") {
		return (
			<span className="inline-flex size-4 shrink-0 items-center justify-center text-warn" role="img" aria-label={t("notice.stopped")}>
				<Minus weight="bold" className="size-3.5" aria-hidden />
			</span>
		);
	}
	return (
		<span className="inline-flex size-4 shrink-0 items-center justify-center text-fg-faint" role="img" aria-label={t("notice.ok")}>
			<Check weight="bold" className="size-3.5" aria-hidden />
		</span>
	);
}

/** A tool-step row: icon, title, quiet detail, status glyph and, when it has more to show, a disclosure. */
function StepRow({
	icon: StepIcon,
	title,
	detail,
	meta,
	status,
	verbose,
	children,
}: {
	icon: Icon;
	title: string;
	detail?: string | null;
	meta?: string | null;
	status?: JobStatus;
	verbose: boolean;
	children?: ReactNode;
}): ReactNode {
	const [open, setOpen] = useState(verbose);
	const content = (
		<>
			<StepIcon className="size-4 shrink-0 text-fg-faint" aria-hidden />
			<span className="min-w-0 truncate text-md text-fg-muted transition-colors duration-(--dur) group-hover/tool:text-fg">{title}</span>
			{detail && <span className="min-w-0 truncate font-mono text-sm text-fg-faint">{detail}</span>}
			{meta && <span className="shrink-0 text-sm text-fg-faint tabular-nums">{meta}</span>}
			{status && <StatusGlyph status={status} />}
		</>
	);
	if (!children) return <div className={rowClass}>{content}</div>;
	return (
		<div className="group/tool">
			<button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className={cn(rowClass, rowInteractive)}>
				{content}
				<CaretRight
					className={cn(
						"size-3.5 shrink-0 text-fg-faint opacity-0 transition-[rotate,opacity] duration-(--dur) ease-(--ease-out) group-hover/tool:opacity-100 group-focus-within/tool:opacity-100",
						open && "rotate-90 opacity-100",
					)}
					aria-hidden
				/>
			</button>
			<Expand open={open} className={wellIndent}>
				{children}
			</Expand>
		</div>
	);
}

/** A Markdown payload in the tool-row well; code blocks carry their own well. */
function Well({ markdown, code }: { markdown: string; code?: boolean }): ReactNode {
	return (
		<div className={cn("max-h-96 overflow-auto text-sm", !code && "rounded-md bg-inset px-3 py-2")}>
			<Markdown text={markdown} />
		</div>
	);
}

/** Verbose view: the exact text omp gave the model, behind its own disclosure. */
function RawText({ source }: { source: NoticeSource }): ReactNode {
	const { t } = useTranslation("chat");
	const [open, setOpen] = useState(false);
	return (
		<div className="group/raw">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				className="-mx-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-fg-faint outline-none transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			>
				<CaretRight className={cn("size-3 shrink-0 transition-[rotate] duration-(--dur) ease-(--ease-out)", open && "rotate-90")} aria-hidden />
				{t("notice.raw")}
			</button>
			<Expand open={open} className="pt-1 pb-2">
				<pre className="selectable max-h-60 overflow-auto rounded-md bg-inset px-3 py-2 font-mono text-code whitespace-pre-wrap text-fg-muted">
					{contentText(source.content)}
				</pre>
			</Expand>
		</div>
	);
}

function JobRow({ job, verbose }: { job: JobNotice; verbose: boolean }): ReactNode {
	const { t } = useTranslation("chat");
	const payload = jobPayload(job);
	return (
		<StepRow
			icon={job.type === "task" ? Robot : TerminalWindow}
			title={jobTitle(job, t)}
			detail={job.type === "task" ? null : commandSummary(job.label ?? "") || null}
			meta={job.durationMs !== null ? fmtDuration(job.durationMs) : job.durationText}
			status={job.status}
			verbose={verbose}
		>
			{job.result === null ? undefined : (
				<>
					{job.truncated && <p className="mb-2 text-sm text-fg-muted">{t("notice.job.preview")}</p>}
					{payload.kind === "empty" ? (
						<p className="text-sm text-fg-faint">{t("notice.job.noOutput")}</p>
					) : payload.kind === "markdown" ? (
						<Well markdown={payload.text} />
					) : (
						<Well markdown={fenced(payload.text, payload.kind === "json" ? "json" : "")} code />
					)}
				</>
			)}
		</StepRow>
	);
}

/** An IRC message: who it is from (or between), and the body collapsed to three lines. */
function IrcCard({ notice }: { notice: Extract<Notice, { kind: "irc" }> }): ReactNode {
	const { t } = useTranslation("chat");
	const [open, setOpen] = useState(false);
	const [overflows, setOverflows] = useState(false);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const body = bodyRef.current;
		if (!body || open) return;
		const measure = () => setOverflows(body.scrollHeight > body.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(body);
		return () => observer.disconnect();
	}, [open]);
	return (
		<div className={cardClass}>
			<div className="flex min-w-0 items-center gap-2">
				<ChatCircleText className="size-4 shrink-0 text-fg-faint" aria-hidden />
				<span className="min-w-0 truncate text-md font-medium text-fg">{ircTitle(notice, t)}</span>
			</div>
			{notice.body && (
				<div
					ref={bodyRef}
					className={cn(
						"selectable mt-1.5 pl-6",
						!open && "max-h-[calc(var(--text-base--line-height)*3)] overflow-hidden",
						!open && overflows && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
					)}
				>
					<Markdown text={notice.body} />
				</div>
			)}
			{(overflows || open) && (
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen(value => !value)}
					className="mt-1 ml-6 rounded-sm text-sm font-medium text-fg-muted outline-none transition-colors duration-(--dur-fast) hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					{t(open ? "notice.irc.less" : "notice.irc.more")}
				</button>
			)}
		</div>
	);
}

const SEVERITY_TONE: Record<AdvisorSeverity, StatusBadgeTone> = { blocker: "err", concern: "warn", nit: "neutral" };

function AdvisorCard({ notice }: { notice: Extract<Notice, { kind: "advisor" }> }): ReactNode {
	const { t } = useTranslation("chat");
	return (
		<div className={cardClass}>
			<div className="flex min-w-0 items-center gap-2">
				<Lightbulb className="size-4 shrink-0 text-fg-faint" aria-hidden />
				<span className="text-md font-medium text-fg">{t("notice.advisor.title")}</span>
				<span className="text-sm text-fg-faint">{t("notice.advisor.notes", { count: notice.notes.length })}</span>
			</div>
			<ul className="mt-2 flex flex-col gap-3 pl-6">
				{notice.notes.map((note, index) => (
					<li key={index} className="flex flex-col items-start gap-1.5">
						{(note.severity || (note.advisor && note.advisor !== "default")) && (
							<div className="flex items-center gap-2">
								{note.severity && <StatusBadge tone={SEVERITY_TONE[note.severity]}>{t(`notice.advisor.severity.${note.severity}`)}</StatusBadge>}
								{note.advisor && note.advisor !== "default" && <span className="text-sm text-fg-faint">{note.advisor}</span>}
							</div>
						)}
						<div className="selectable min-w-0 self-stretch">
							<Markdown text={note.note} />
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}

/** The user ran a skill: a compact row on the user's side, opening to the skill's text. */
function SkillRow({ notice, verbose }: { notice: Extract<Notice, { kind: "skill" }>; verbose: boolean }): ReactNode {
	const { t } = useTranslation("chat");
	const [open, setOpen] = useState(verbose);
	return (
		<div className="group/tool flex flex-col items-end">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				title={notice.path ?? undefined}
				className="-mr-2 flex h-8 max-w-[85%] items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			>
				<CaretRight
					className={cn(
						"size-3.5 shrink-0 text-fg-faint opacity-0 transition-[rotate,opacity] duration-(--dur) ease-(--ease-out) group-hover/tool:opacity-100 group-focus-within/tool:opacity-100",
						open && "rotate-90 opacity-100",
					)}
					aria-hidden
				/>
				<BookOpenText className="size-4 shrink-0 text-fg-faint" aria-hidden />
				<span className="min-w-0 truncate text-md text-fg-muted transition-colors duration-(--dur) group-hover/tool:text-fg">{t("notice.skill.used", { name: notice.name })}</span>
			</button>
			{notice.args && <p className="selectable max-w-[85%] text-base whitespace-pre-wrap text-fg">{notice.args}</p>}
			<div className="w-full">
				<Expand open={open} className="selectable pt-2 pb-1">
					<Well markdown={notice.text} />
				</Expand>
			</div>
		</div>
	);
}

export interface NoticeRowProps {
	/** A displayed `custom_message` entry (anything but `collab-prompt`, which is a user message). */
	entry: NoticeSource;
	mode: TranscriptMode;
}

export function NoticeRow({ entry, mode }: NoticeRowProps): ReactNode {
	const { t } = useTranslation("chat");
	if (entry.customType === "tsp-notice") return (
		<div role="note" className="-mx-2 flex min-w-0 items-start gap-2.5 px-2 py-1 text-sm text-fg-muted">
			<Info aria-hidden className="mt-0.5 size-4 shrink-0" />
			<p className="selectable min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{contentText(entry.content)}</p>
		</div>
	);
	const notice = parseNotice(entry);
	const verbose = mode === "verbose";
	let body: ReactNode;
	switch (notice.kind) {
		case "jobs":
			body = (
				<div>
					{notice.jobs.map((job, index) => (
						<JobRow key={`${job.id}-${index}`} job={job} verbose={verbose} />
					))}
				</div>
			);
			break;
		case "launch":
			body = (
				<div>
					{notice.processes.map((process, index) => (
						<StepRow
							key={`${process.name}-${index}`}
							icon={TerminalWindow}
							title={processText(process, t)}
							status={process.failed ? "failed" : "ok"}
							verbose={verbose}
						/>
					))}
				</div>
			);
			break;
		case "irc":
			body = <IrcCard notice={notice} />;
			break;
		case "advisor":
			body = <AdvisorCard notice={notice} />;
			break;
		case "skill":
			body = <SkillRow notice={notice} verbose={verbose} />;
			break;
		case "other":
			body = (
				<StepRow icon={Info} title={firstLine(notice.text) || t("notice.other")} verbose={verbose}>
					<Well markdown={notice.text} />
				</StepRow>
			);
			break;
	}
	if (!verbose) return body;
	return (
		<div className="flex flex-col gap-1">
			{body}
			<RawText source={entry} />
		</div>
	);
}
