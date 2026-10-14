/**
 * Daily estimated API cost (DESIGN §4.18): zero-based axis with 3 or 4 ticks, `--border` gridlines, a
 * dashed daily-average line, values printed above the bars in the 7-day range, today in `--accent` and
 * labeled as the day so far. Each bar is a full-height button whose fill is revealed with `clip-path`;
 * the clip shape carries the 4px top corners (a rounded box would lose its corners to the clip), and a
 * data change animates the clip instead of the height. Hovering or focusing a bar shows its date, cost
 * and requests in a tooltip card. The bars form one tab stop: arrow keys, Home and End move between days.
 */
import type { SpendDay } from "@shared/contracts/extensions";
import { type KeyboardEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Cell, cn, HeaderCell, Table, TableHead, TableRow, Tooltip } from "@/ui";
import { focusRing } from "@/ui/styles";
import { formatUsd } from "../format";
import { chartScale, dailyAverage, formatTick } from "./model";

export function SpendChart({ days, titleId }: { days: readonly SpendDay[]; titleId: string }) {
	const { t, i18n } = useTranslation("extensions");
	const scale = chartScale(Math.max(0, ...days.map(day => day.cost)));
	const average = dailyAverage(days);
	const wide = days.length <= 7;
	const last = days.length - 1;
	const [active, setActive] = useState(last);
	const bars = useRef<(HTMLButtonElement | null)[]>([]);
	const longDate = new Intl.DateTimeFormat(i18n.language, { weekday: "long", month: "short", day: "numeric" });
	const tick = new Intl.DateTimeFormat(i18n.language, wide ? { weekday: "short", day: "numeric" } : { month: "short", day: "numeric" });
	const percentOf = (value: number) => (value / scale.top) * 100;
	const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
		const moves: Record<string, number | undefined> = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: last };
		const next = moves[event.key];
		if (next === undefined) return;
		event.preventDefault();
		const index = Math.min(last, Math.max(0, next));
		setActive(index);
		bars.current[index]?.focus();
	};
	const columns = wide ? "gap-3 px-3" : "gap-1 px-1";

	return (
		<figure aria-labelledby={titleId} className="flex flex-col">
			<div className="flex">
				<div aria-hidden className="relative mt-6 h-50 w-14 shrink-0">
					{scale.ticks.map(value => (
						<span key={value} className="absolute right-2 translate-y-1/2 text-xs tabular-nums text-fg-faint" style={{ bottom: `${percentOf(value)}%` }}>
							{formatTick(value, scale.step)}
						</span>
					))}
				</div>
				<div className="min-w-0 flex-1">
					<div className="relative mt-6 h-50">
						{scale.ticks.map(value => (
							<span
								key={value}
								aria-hidden
								className={cn("absolute inset-x-0 border-t", value === 0 ? "border-border-strong" : "border-border")}
								style={{ bottom: `${percentOf(value)}%` }}
							/>
						))}
						<ul aria-label={t("usage.chart.label")} onKeyDown={onKeyDown} className={cn("absolute inset-0 flex items-end", columns)}>
							{days.map((day, index) => {
								const fill = percentOf(day.cost);
								const today = index === last;
								const text = t(today ? "usage.chart.barToday" : "usage.chart.bar", { date: longDate.format(day.start), cost: formatUsd(day.cost), count: day.requests });
								return (
									<li key={day.date} className="relative flex h-full min-w-0 flex-1 justify-center">
										{wide && (
											<span
												aria-hidden
												// Above the dashed average line, on a panel wash so the line never strikes through the figure.
												className={cn(
													"pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-sm bg-panel/85 px-1 text-xs tabular-nums",
													today ? "text-fg" : "text-fg-muted",
												)}
												style={{ bottom: `calc(${fill}% + 0.25rem)` }}
											>
												{formatUsd(day.cost)}
											</span>
										)}
										<Tooltip
											className="items-start p-3 leading-normal font-normal"
											content={
												<span className="flex min-w-36 flex-col gap-1">
													<span className="font-semibold">{today ? t("usage.chart.todayDate", { date: longDate.format(day.start) }) : longDate.format(day.start)}</span>
													<span className="flex justify-between gap-4 text-fg-muted">
														{t("usage.chart.cost")}
														<span className="font-mono tabular-nums text-fg">{formatUsd(day.cost)}</span>
													</span>
													<span className="flex justify-between gap-4 text-fg-muted">
														{t("usage.chart.requests")}
														<span className="font-mono tabular-nums text-fg">{day.requests}</span>
													</span>
												</span>
											}
										>
											<button
												ref={element => {
													bars.current[index] = element;
												}}
												type="button"
												tabIndex={index === active ? 0 : -1}
												aria-label={text}
												onFocus={() => setActive(index)}
												className={cn("group relative h-full w-full rounded-t-sm", wide && "max-w-16", focusRing)}
											>
												<span
													aria-hidden
													className={cn(
														"absolute inset-0 transition-[clip-path,filter] duration-(--dur-spring-gentle) ease-(--ease-spring) group-hover:brightness-110",
														day.cost > 0 ? (today ? "bg-accent" : "bg-fg/30") : "bg-border",
													)}
													// A positive amount always shows at least 2px in the bar color, so it stays apart from a zero day's gray stub.
													style={{
														clipPath:
															day.cost > 0
																? `inset(min(${100 - fill}%, calc(100% - 2px)) 0 0 0 round var(--radius-sm) var(--radius-sm) 0 0)`
																: "inset(calc(100% - 2px) 0 0 0)",
													}}
												/>
											</button>
										</Tooltip>
									</li>
								);
							})}
						</ul>
						{average > 0 && (
							<span
								aria-hidden
								className="pointer-events-none absolute inset-x-0 border-t border-dashed border-fg-faint"
								style={{ bottom: `${percentOf(average)}%` }}
							/>
						)}
					</div>
					<div aria-hidden className={cn("flex pt-2", columns)}>
						{days.map((day, index) => {
							const labeled = wide || (last - index) % 7 === 0;
							return (
								<span key={day.date} className={cn("min-w-0 flex-1 whitespace-nowrap text-center text-xs", index === last ? "font-semibold text-fg" : "text-fg-faint")}>
									{index === last ? t("usage.chart.today") : labeled ? tick.format(day.start) : ""}
								</span>
							);
						})}
					</div>
				</div>
			</div>
			<p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
				{average > 0 && (
					<span className="inline-flex items-center gap-2">
						<span aria-hidden className="w-4 border-t border-dashed border-fg-faint" />
						{t("usage.chart.average", { cost: formatUsd(average) })}
					</span>
				)}
				<span className="text-fg-faint">{t("usage.chart.todayNote")}</span>
			</p>
			<details className="mt-3 text-sm">
				<summary className={cn("w-fit cursor-pointer rounded-sm text-fg-muted hover:text-fg", focusRing)}>{t("usage.chart.values")}</summary>
				<Table className="mt-2">
					<TableHead className="bg-panel">
						<tr>
							<HeaderCell>{t("usage.chart.date")}</HeaderCell>
							<HeaderCell align="right">{t("usage.chart.cost")}</HeaderCell>
							<HeaderCell align="right">{t("usage.chart.requests")}</HeaderCell>
						</tr>
					</TableHead>
					<tbody>
						{days.map((day, index) => (
							<TableRow key={day.date}>
								<Cell>{index === last ? t("usage.chart.todayDate", { date: longDate.format(day.start) }) : longDate.format(day.start)}</Cell>
								<Cell align="right" numeric>
									{formatUsd(day.cost)}
								</Cell>
								<Cell align="right" numeric>
									{day.requests}
								</Cell>
							</TableRow>
						))}
					</tbody>
				</Table>
			</details>
		</figure>
	);
}
