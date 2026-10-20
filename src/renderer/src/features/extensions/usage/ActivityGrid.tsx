/**
 * Activity grid (DESIGN §4.18): omp's model requests per local day as a GitHub-style calendar, one column per week
 * and the newest week on the right. It shows as many whole weeks as fit, up to a year, so Home's narrow card gets the
 * last few months and the Usage page the year. A day's shade ranks its requests among the active days shown
 * (`activityWeeks`); hovering or focusing a day shows its date, requests and estimated API cost in a tooltip. The
 * days form one tab stop: arrow keys move a day (up and down) or a week (left and right), Home and End jump to the ends.
 */
import type { SpendDay, SpendSummary } from "@shared/contracts/extensions";
import { type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn, Tooltip } from "@/ui";
import { focusRing } from "@/ui/styles";
import { formatUsd } from "../format";
import { type Loaded, useLoad } from "../shared";
import { ACTIVITY_DAYS, ACTIVITY_MAX_WEEKS, type ActivityCell, type ActivityLevel, activityWeeks, weekStart } from "./model";
import { usageMemory } from "./viewStore";

/**
 * The year the grid draws, read once per mount and kept in `usageMemory`, so Home and the Usage page show the last
 * one at once while a fresh one loads. `data` falls back to that kept summary.
 */
export function useActivity(): Loaded<SpendSummary> {
	const loaded = useLoad(async () => {
		const summary = await window.vomp.invoke("extensions:spend", ACTIVITY_DAYS);
		usageMemory.activity = summary;
		return summary;
	}, []);
	return { ...loaded, data: loaded.data ?? usageMemory.activity };
}

/**
 * Cell edge and gap in CSS px, GitHub's proportions. A narrow grid shows fewer weeks at the smallest cell; once a
 * full year fits, cells grow up to the largest size so the year fills a wide card.
 */
const CELL = 11;
const CELL_MAX = 16;
const GAP = 3;
/** Width of the weekday label column. */
const LABELS = 28;
/** Month names closer than this many weeks to the next one are left out, so labels never collide. */
const MONTH_MIN_WEEKS = 3;

const shades: Record<ActivityLevel, string> = {
	0: "bg-heat-0",
	1: "bg-heat-1",
	2: "bg-heat-2",
	3: "bg-heat-3",
	4: "bg-heat-4",
};

/** The element's content width in CSS px, measured before paint and on every resize. */
function useWidth(): [(element: HTMLDivElement | null) => void, number] {
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		if (!element) return;
		setWidth(element.clientWidth);
		const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	return [setElement, width];
}

export function ActivityGrid({
	days,
	labelledBy,
	dayLabels = false,
	className,
}: {
	/** Oldest first, ending today, as `extensions:spend` reports them. */
	days: readonly SpendDay[];
	/** Id of the heading that names the grid. */
	labelledBy: string;
	/** Weekday names beside the rows; leave them off where width is short. */
	dayLabels?: boolean;
	className?: string;
}) {
	const { t, i18n } = useTranslation("extensions");
	const [measure, width] = useWidth();
	const available = width - (dayLabels ? LABELS : 0) + GAP;
	const size = Math.max(CELL, Math.min(CELL_MAX, Math.floor(available / ACTIVITY_MAX_WEEKS) - GAP));
	const step = size + GAP;
	const count = Math.max(1, Math.min(ACTIVITY_MAX_WEEKS, Math.floor(available / step)));
	const rows = `repeat(7, ${size}px)`;
	// A fifth of the edge, GitHub's 2px at the smallest cell.
	const corner = Math.round(size / 5);
	const firstDay = weekStart(i18n.language);
	const weeks = useMemo(() => activityWeeks(days, count, firstDay), [days, count, firstDay]);
	const cells = weeks.flat();
	const today = days.at(-1)?.date;
	const lastIndex = cells.findLastIndex(cell => cell !== null);
	const firstIndex = cells.findIndex(cell => cell !== null);
	const [active, setActive] = useState<string | null>(null);
	const activeIndex = Math.max(
		firstIndex,
		active === null ? lastIndex : cells.findIndex(cell => cell?.day.date === active),
	);
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);

	const longDate = new Intl.DateTimeFormat(i18n.language, { weekday: "long", month: "short", day: "numeric" });
	const shortDate = new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric", year: "numeric" });
	const monthName = new Intl.DateTimeFormat(i18n.language, { month: "short" });
	const weekdayName = new Intl.DateTimeFormat(i18n.language, { weekday: "short" });
	const number = new Intl.NumberFormat(i18n.language);

	// A month's name heads the first week whose top day falls in it.
	const months: { week: number; label: string }[] = [];
	weeks.forEach((week, index) => {
		const top = week.find(cell => cell !== null);
		if (!top) return;
		const month = new Date(top.day.start).getMonth();
		const previous = weeks[index - 1]?.find(cell => cell !== null);
		if (previous && new Date(previous.day.start).getMonth() === month) return;
		months.push({ week: index, label: monthName.format(top.day.start) });
	});
	const shownMonths = months.filter((month, index) => (months[index + 1]?.week ?? count + MONTH_MIN_WEEKS) - month.week >= MONTH_MIN_WEEKS);

	const shown = cells.flatMap(cell => (cell ? [cell] : []));
	const total = shown.reduce((sum, cell) => sum + cell.day.requests, 0);
	const since = shown[0] ? shortDate.format(shown[0].day.start) : "";

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const moves: Record<string, number | undefined> = {
			ArrowUp: activeIndex - 1,
			ArrowDown: activeIndex + 1,
			ArrowLeft: activeIndex - 7,
			ArrowRight: activeIndex + 7,
			Home: firstIndex,
			End: lastIndex,
		};
		const next = moves[event.key];
		if (next === undefined) return;
		event.preventDefault();
		const target = cells[next];
		if (!target) return;
		setActive(target.day.date);
		buttons.current[next]?.focus();
	};

	const label = (cell: ActivityCell) =>
		t(cell.day.date === today ? "usage.chart.barToday" : "usage.chart.bar", {
			date: longDate.format(cell.day.start),
			cost: formatUsd(cell.day.cost),
			count: cell.day.requests,
		});

	return (
		<figure aria-labelledby={labelledBy} className={cn("flex min-w-0 flex-col", className)}>
			<div ref={measure} className="min-w-0">
				{width > 0 && (
					<div className="flex">
						{dayLabels && (
							<div aria-hidden className="mt-5 grid shrink-0" style={{ width: LABELS, gap: GAP, gridTemplateRows: rows }}>
								{Array.from({ length: 7 }, (_, row) => {
									// Mon, Wed and Fri, as GitHub labels them. 7 January 2024 was a Sunday.
									const weekday = (firstDay + row) % 7;
									return (
										<span key={row} className="flex items-center text-xs text-fg-faint">
											{weekday % 2 === 1 ? weekdayName.format(new Date(2024, 0, 7 + weekday)) : ""}
										</span>
									);
								})}
							</div>
						)}
						<div className="min-w-0">
							<div aria-hidden className="relative mb-1 h-4">
								{shownMonths.map(month => (
									<span key={month.week} className="absolute top-0 whitespace-nowrap text-xs text-fg-faint" style={{ left: month.week * step }}>
										{month.label}
									</span>
								))}
							</div>
							<div
								role="group"
								aria-label={t("usage.activity.label")}
								onKeyDown={onKeyDown}
								className="grid grid-flow-col"
								style={{ gap: GAP, gridTemplateRows: rows, gridAutoColumns: `${size}px` }}
							>
								{cells.map((cell, index) =>
									cell ? (
										<Tooltip
											key={cell.day.date}
											className="items-start p-3 leading-normal font-normal"
											content={
												<span className="flex min-w-36 flex-col gap-1">
													<span className="font-semibold">
														{cell.day.date === today ? t("usage.chart.todayDate", { date: longDate.format(cell.day.start) }) : longDate.format(cell.day.start)}
													</span>
													<span className="flex justify-between gap-4 text-fg-muted">
														{t("usage.chart.requests")}
														<span className="font-mono tabular-nums text-fg">{number.format(cell.day.requests)}</span>
													</span>
													<span className="flex justify-between gap-4 text-fg-muted">
														{t("usage.chart.cost")}
														<span className="font-mono tabular-nums text-fg">{formatUsd(cell.day.cost)}</span>
													</span>
												</span>
											}
										>
											<button
												ref={element => {
													buttons.current[index] = element;
												}}
												type="button"
												tabIndex={index === activeIndex ? 0 : -1}
												aria-label={label(cell)}
												onFocus={() => setActive(cell.day.date)}
												style={{ borderRadius: corner }}
												className={cn("size-full hover:outline hover:outline-1 hover:outline-fg-muted", shades[cell.level], focusRing)}
											/>
										</Tooltip>
									) : (
										<span key={`empty-${index}`} aria-hidden />
									),
								)}
							</div>
						</div>
					</div>
				)}
			</div>
			<figcaption className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-fg-muted">
				<span>{total > 0 ? t("usage.activity.summary", { count: total, total: number.format(total), date: since }) : t("usage.activity.none", { date: since })}</span>
				<span className="inline-flex items-center gap-1 text-fg-faint">
					<span aria-hidden>{t("usage.activity.less")}</span>
					{([0, 1, 2, 3, 4] as const).map(level => (
						<span key={level} aria-hidden className={cn("size-[11px] rounded-[2px]", shades[level])} />
					))}
					<span aria-hidden>{t("usage.activity.more")}</span>
					<span className="sr-only">{t("usage.activity.legend")}</span>
				</span>
			</figcaption>
		</figure>
	);
}
