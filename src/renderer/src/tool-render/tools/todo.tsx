/**
 * `todo`: phased task-list ops and the resulting board. `TodoBoard` is the app's task board, shared by the
 * transcript (the turn's latest update), the expanded tool row and the Tasks pane; `TodoChangeRow` is an earlier
 * update shrunk to what it changed.
 */
import { CaretRight, CheckCircle, Circle, CircleHalf, ListChecks, XCircle } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { listRowMotion } from "../../features/panes/common";
import { parsePhases, type TodoPhase, type TodoStatus, type TodoUpdate, todoChanges, todoCounts } from "../../features/panes/derive";
import { cn, Expand, Progress, spring } from "../../ui";
import { Badges, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, str, truncate } from "../util";

/** Boards longer than this fold their completed tasks into one count line. */
const FOLD_COMPLETED_OVER = 6;

const GLYPH: Record<TodoStatus, ReactNode> = {
	completed: <CheckCircle weight="fill" className="size-4 text-accent" aria-hidden />,
	in_progress: <CircleHalf weight="fill" className="size-4 text-accent" aria-hidden />,
	pending: <Circle className="size-4 text-fg-faint" aria-hidden />,
	abandoned: <XCircle className="size-4 text-fg-faint" aria-hidden />,
};

/** Stable keys for rows identified by their text: `text#n` for the nth repeat, so reordered tasks keep their row. */
function textKeys(texts: readonly string[]): string[] {
	const seen = new Map<string, number>();
	return texts.map(text => {
		const n = seen.get(text) ?? 0;
		seen.set(text, n + 1);
		return `${text}#${n}`;
	});
}

/** "3 of 7 tasks" with the bar, plus skipped tasks counted apart. */
function BoardHeader({ phases }: { phases: readonly TodoPhase[] }): ReactNode {
	const { t } = useTranslation("panes");
	const { done, total, abandoned } = todoCounts(phases);
	return (
		<div className="flex items-center gap-3">
			<ListChecks className="size-4 shrink-0 text-fg-muted" aria-hidden />
			<p className="min-w-0 flex-1 truncate text-sm text-fg-muted">
				<span className="font-semibold text-fg">{t("work.todo.title")}</span>
				<span aria-hidden> · </span>
				<span className="tabular-nums">{t("work.todo.count", { done, count: total })}</span>
				{abandoned > 0 && (
					<>
						<span aria-hidden> · </span>
						{t("work.todo.skipped", { count: abandoned })}
					</>
				)}
			</p>
			{total > 0 && <Progress value={(done / total) * 100} aria-label={t("work.todo.progress")} className="w-24 shrink-0" />}
		</div>
	);
}

/**
 * omp's task board: a header with the count and a bar, phase sub-headers when omp phased the board, one row per task
 * with a status glyph. Past {@link FOLD_COMPLETED_OVER} rows, completed tasks fold into a count line that opens them.
 */
export function TodoBoard({ phases, className }: { phases: readonly TodoPhase[]; className?: string }): ReactNode {
	const { t } = useTranslation("panes");
	const currentId = useId();
	const [showDone, setShowDone] = useState(false);
	const tasks = phases.flatMap(phase => phase.tasks);
	const completed = tasks.filter(task => task.status === "completed").length;
	const folded = tasks.length > FOLD_COMPLETED_OVER && completed > 0 && !showDone;
	const phased = phases.length > 1;
	return (
		<div className={cn("rounded-lg border border-border bg-panel p-card", className)}>
			<BoardHeader phases={phases} />
			{tasks.length > FOLD_COMPLETED_OVER && completed > 0 && (
				<button
					type="button"
					aria-expanded={showDone}
					onClick={() => setShowDone(value => !value)}
					className="mt-2 -mx-1 flex h-7 w-[calc(100%+0.5rem)] items-center gap-2 rounded-sm px-1 text-left text-sm text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
				>
					<CheckCircle weight="fill" className="size-4 shrink-0 text-accent" aria-hidden />
					<span className="min-w-0 flex-1">{showDone ? t("work.todo.hideCompleted") : t("work.todo.completed", { count: completed })}</span>
					<CaretRight className={cn("size-3.5 shrink-0 text-fg-faint transition-[rotate] duration-(--dur) ease-(--ease-out)", showDone && "rotate-90")} aria-hidden />
				</button>
			)}
			<ol className={cn("flex flex-col", tasks.length > FOLD_COMPLETED_OVER && completed > 0 ? "mt-1" : "mt-2")}>
				{phases.map((phase, index) => {
					const keys = textKeys(phase.tasks.map(task => task.content));
					const shown = phase.tasks.map((task, taskIndex) => ({ task, key: keys[taskIndex] })).filter(({ task }) => !folded || task.status !== "completed");
					if (shown.length === 0) return null;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: phase order is the identity
						<li key={index} className={cn(phased && "mt-2 first:mt-0")}>
							{phased && phase.name && <p className="mb-1 px-1 text-xs font-semibold text-fg-faint">{phase.name}</p>}
							<ul className="flex flex-col">
								<AnimatePresence initial={false}>
									{shown.map(({ task, key }) => (
										<motion.li
											key={key}
											layout="position"
											{...listRowMotion}
											className={cn(
												"relative -mx-1 flex min-h-7 items-start gap-2 rounded-sm px-1 py-1 text-md",
												task.status === "in_progress" && "font-medium text-fg",
												task.status === "completed" && "text-fg-muted",
												task.status === "abandoned" && "text-fg-faint line-through",
												task.status === "pending" && "text-fg",
											)}
										>
											{task.status === "in_progress" && (
												<motion.span aria-hidden layoutId={`${currentId}-current`} transition={spring.snappy} className="absolute inset-0 rounded-sm bg-accent-muted" />
											)}
											<span className="relative mt-px inline-flex size-4 shrink-0">
												<AnimatePresence initial={false} mode="popLayout">
													<motion.span
														key={task.status}
														initial={{ opacity: 0, scale: 0.6 }}
														animate={{ opacity: 1, scale: 1 }}
														exit={{ opacity: 0, scale: 0.6 }}
														transition={spring.snappy}
														className="inline-flex"
													>
														{GLYPH[task.status]}
													</motion.span>
												</AnimatePresence>
											</span>
											<span className="sr-only">{t(`tasks.status.${task.status}`)}</span>
											<span className="relative min-w-0 flex-1 leading-5">{task.content}</span>
										</motion.li>
									))}
								</AnimatePresence>
							</ul>
						</li>
					);
				})}
			</ol>
		</div>
	);
}

/** Changes named before the rest fold into "N more". */
const CHANGES_SHOWN = 2;

/**
 * An earlier board update in a turn, shrunk to one line of what it changed ("Completed “Read the flow” · Started
 * “Add tokens”") with the count after it. Opens to the board as it stood then.
 */
export function TodoChangeRow({ update }: { update: TodoUpdate }): ReactNode {
	const { t } = useTranslation("panes");
	const [open, setOpen] = useState(false);
	const changes = todoChanges(update.previous, update.phases);
	const { done, total, abandoned } = todoCounts(update.phases);
	// The chat's first board lists every task as new; say it was made instead of naming them.
	const named =
		update.previous === null
			? [t("work.todo.created", { count: total + abandoned })]
			: changes.slice(0, CHANGES_SHOWN).map(change => t(`work.todo.change.${change.kind}`, { task: `“${truncate(normalizeWs(change.task), 48)}”` }));
	if (update.previous !== null && changes.length > CHANGES_SHOWN) named.push(t("work.todo.more", { count: changes.length - CHANGES_SHOWN }));
	return (
		<div className="group/todo">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				className="-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			>
				<ListChecks className="size-4 shrink-0 text-fg-faint" aria-hidden />
				<span className="min-w-0 truncate text-md text-fg-muted group-hover/todo:text-fg">{named.length > 0 ? named.join(" · ") : t("work.todo.unchanged")}</span>
				<span className="shrink-0 font-mono text-sm tabular-nums text-fg-faint">{t("work.todo.fraction", { done, total })}</span>
				<CaretRight
					className={cn(
						"ml-auto size-3.5 shrink-0 text-fg-faint opacity-0 transition-[rotate,opacity] duration-(--dur) ease-(--ease-out) group-hover/todo:opacity-100 group-focus-within/todo:opacity-100",
						open && "rotate-90 opacity-100",
					)}
					aria-hidden
				/>
			</button>
			<Expand open={open} className="pt-1 pb-3 pl-6.5">
				<TodoBoard phases={update.phases} />
			</Expand>
		</div>
	);
}

/**
 * Normalize call args to a flat op list. The current `todo` contract sends a
 * single top-level op `{op,...}`; legacy transcripts still carry the batched
 * `{ops:[...]}` shape. Non-record entries (streaming deltas) are dropped.
 */
function toOps(args: ToolRenderProps["args"]): unknown[] {
	if (Array.isArray(args.ops)) return args.ops;
	return typeof args.op === "string" ? [args] : [];
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const ops = toOps(args);
	const counts: Record<string, number> = {};
	const order: string[] = [];
	let firstTask: string | null = null;
	for (const entry of ops) {
		if (!isRecord(entry)) continue;
		const op = str(entry.op) ?? "update";
		if (counts[op] === undefined) {
			counts[op] = 0;
			order.push(op);
		}
		counts[op]++;
		if (firstTask === null) {
			firstTask = str(entry.task) ?? str(entry.phase);
			if (firstTask === null && Array.isArray(entry.list)) {
				const head = entry.list.find(isRecord);
				if (head && Array.isArray(head.items)) firstTask = str(head.items[0]);
			}
		}
	}
	const labels = order.map(op => (counts[op] > 1 ? `${op}×${counts[op]}` : op));
	return (
		<>
			<Badges items={labels.length > 0 ? labels : ["update"]} />
			{firstTask !== null && <span> {truncate(normalizeWs(firstTask), 60)}</span>}
		</>
	);
}

/** One arg op as a labeled row: op name + the task/phase/list it touches. */
function opRow(entry: unknown, key: number): ReactNode {
	if (!isRecord(entry)) return null;
	const parts: string[] = [];
	const task = str(entry.task);
	const phase = str(entry.phase);
	if (task !== null) parts.push(task);
	if (phase !== null) parts.push(phase);
	if (Array.isArray(entry.items) && entry.items.length > 0) {
		parts.push(`${entry.items.length} item${entry.items.length === 1 ? "" : "s"}`);
	}
	if (Array.isArray(entry.list) && entry.list.length > 0) {
		let tasks = 0;
		for (const phaseEntry of entry.list) {
			if (isRecord(phaseEntry) && Array.isArray(phaseEntry.items)) tasks += phaseEntry.items.length;
		}
		parts.push(`${entry.list.length} phase${entry.list.length === 1 ? "" : "s"} · ${tasks} tasks`);
	}
	return (
		<Row key={key} k={str(entry.op) ?? "update"}>
			{truncate(normalizeWs(parts.join(" · ")), 160)}
		</Row>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const ops = toOps(args);
	const rec = detailsRecord(result);
	const phases = rec && Array.isArray(rec.phases) && !result?.isError ? parsePhases(rec.phases) : null;
	return (
		<>
			{ops.length > 0 && <div className="tv-list">{ops.map(opRow)}</div>}
			{phases !== null ? <TodoBoard phases={phases} /> : <ResultText result={result} maxLines={8} />}
		</>
	);
}

export const todoRenderer: ToolRenderer = { Summary, Body };
