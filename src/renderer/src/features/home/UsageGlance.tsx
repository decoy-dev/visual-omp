/**
 * Home → Usage: a bare section with the three providers closest to a plan limit (each provider's
 * binding window, as Usage & limits shows it) and the last 7 days' estimated API cost. Reads the shared
 * limits snapshot and one 7-day spend summary, which it leaves in `usageMemory` so the Usage page opens
 * with figures already in place.
 */
import type { TFunction } from "i18next";
import { Fragment, type ReactNode, useEffect, useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Warning } from "@phosphor-icons/react";
import { formatAge, formatDuration, formatUsd } from "@/features/extensions/format";
import { useLoad } from "@/features/extensions/shared";
import { refreshUsageLimits, useUsageLimits, useUsageLimitsStatus } from "@/features/extensions/usage/limitsStore";
import { type LimitRow, planLimits, providerName, providerSummary } from "@/features/extensions/usage/planUsage";
import { usageMemory } from "@/features/extensions/usage/viewStore";
import { useNow } from "@/shell/hooks";
import { openUsage } from "@/state/navigation";
import { cn, Meter, Skeleton } from "@/ui";
import { HomeSectionHeader } from "./Section";

const RANGE_DAYS = 7;
const MAX_PROVIDERS = 3;

const stateInks: Record<LimitRow["tone"], string> = { ok: "text-fg-muted", warn: "text-warn", err: "text-err" };

interface GlanceRow {
	provider: string;
	name: string;
	row: LimitRow | null;
}

/** "62% of the 5h limit used"; a window without a duration reads "62% used · Monthly limit". */
function shareText(row: LimitRow, percent: number, t: TFunction<"extensions">): string {
	if (row.durationMs !== null && row.durationMs > 0) return t("usage.plan.meterValue", { percent, window: formatDuration(row.durationMs) });
	return `${t("usage.limits.used", { percent })} · ${row.monthly ? t("usage.limits.window.monthly") : row.label}`;
}

/** "Resets in 2h", "Regen in 2h", "Awaiting updated usage" once the reset passed, or null without a reset. */
function resetText(row: LimitRow, now: number, t: TFunction<"extensions">): string | null {
	if (row.resetsAt === null) return null;
	if (row.resetsAt <= now) return t("usage.limits.awaiting");
	const time = formatDuration(row.resetsAt - now);
	return row.resetLabel ? t("usage.limits.resetVerbIn", { verb: row.resetLabel[0].toUpperCase() + row.resetLabel.slice(1), time }) : t("usage.limits.resetsIn", { time });
}

export function UsageGlance(): ReactNode {
	const { t } = useTranslation("home");
	const { t: tx, i18n } = useTranslation("extensions");
	const snapshot = useUsageLimits(true);
	const status = useUsageLimitsStatus();
	const now = useNow(30_000);
	const id = useId();
	// Read omp's cached figures right away (joining a read already running).
	useEffect(() => {
		void refreshUsageLimits();
	}, []);
	const spend = useLoad(async () => {
		const summary = await window.vomp.invoke("extensions:spend", RANGE_DAYS);
		if (summary.days.length === RANGE_DAYS) usageMemory.spend = summary;
		return summary;
	}, []);
	const seeded = usageMemory.spend?.days.length === RANGE_DAYS ? usageMemory.spend : null;
	const summary = spend.data ?? seeded;

	const rows = useMemo((): GlanceRow[] => {
		if (!snapshot) return [];
		return planLimits(snapshot)
			.map(provider => ({ provider: provider.provider, name: providerName(provider.provider), row: providerSummary(provider).binding?.row ?? null }))
			.sort((a, b) => (b.row?.fraction ?? -1) - (a.row?.fraction ?? -1))
			.slice(0, MAX_PROVIDERS);
	}, [snapshot]);

	const limitsLoading = !snapshot && !status.error;
	const limitsFailed = !snapshot && status.error !== null && !status.checking;
	// A failed refresh keeps the last figures on screen, so say how old they are, as Usage & limits does.
	const limitsStale = snapshot !== null && status.error !== null && !status.checking;
	const oldest = snapshot ? Math.min(snapshot.generatedAt, ...snapshot.reports.map(report => report.fetchedAt)) : null;
	const spendLoading = !summary && !spend.error;
	const spendStale = summary !== null && spend.error !== null && !spend.loading;
	const skipped = summary?.skippedFiles ?? 0;
	const cost = summary?.totals.cost ?? null;
	// "No recorded usage" only when every read worked and nothing was skipped; otherwise zero may just be missing data.
	const empty =
		snapshot !== null && !status.error && rows.length === 0 && summary !== null && !spend.error && skipped === 0 && summary.totals.cost === 0;

	return (
		<section aria-labelledby={id} aria-busy={status.checking || spend.loading} className="@container/usage-glance min-w-0">
			<HomeSectionHeader id={id} title={t("usage.title")} action={{ label: t("usage.open"), onClick: () => openUsage() }} />
			<div className="flex flex-col">
				{empty ? (
					<p className="text-sm text-fg-muted">{tx("usage.recorded.empty")}</p>
				) : (
					<>
						{limitsLoading && [0, 1].map(index => <SkeletonRow key={index} />)}
						{limitsFailed && <p className="flex min-h-9 items-center text-sm text-fg-muted">{tx("usage.limits.failed")}</p>}
						{rows.map(entry => (
							<ProviderRow key={entry.provider} entry={entry} now={now} />
						))}
						{limitsStale && oldest !== null && <Qualifier>{tx("usage.limits.staleFailed", { age: formatAge(oldest, now, i18n.language) })}</Qualifier>}

						{spendLoading ? (
							<SkeletonRow />
						) : summary === null ? (
							<p className="flex min-h-9 items-center text-sm text-fg-muted">{tx("usage.recorded.failed")}</p>
						) : (
							<>
								<div className="flex min-h-9 items-center justify-between gap-3">
									<span className="min-w-0 truncate text-md font-medium text-fg">{t("usage.cost")}</span>
									<span className="shrink-0 font-mono text-md text-fg tabular-nums">{formatUsd(cost ?? 0)}</span>
								</div>
								<p className="text-sm text-fg-muted">{t("usage.costNote")}</p>
								{spendStale && <Qualifier>{tx("usage.recorded.staleFailed")}</Qualifier>}
								{skipped > 0 && <Qualifier>{tx("usage.recorded.partial", { count: skipped })}</Qualifier>}
							</>
						)}
					</>
				)}
			</div>
		</section>
	);
}

/** A quiet warning under the figures it qualifies: a glyph and words, so it never rests on color alone. */
function Qualifier({ children }: { children: ReactNode }): ReactNode {
	return (
		<p className="mt-1 flex items-start gap-1.5 text-sm text-fg-muted">
			<Warning className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
			<span className="min-w-0">{children}</span>
		</p>
	);
}

function SkeletonRow(): ReactNode {
	return (
		<div aria-hidden className="flex h-9 items-center gap-3">
			<Skeleton width={96} height={14} />
			<Skeleton height={6} className="max-w-60 flex-1" />
		</div>
	);
}

function ProviderRow({ entry, now }: { entry: GlanceRow; now: number }): ReactNode {
	const { t: tx } = useTranslation("extensions");
	const { name, row } = entry;
	const percent = row?.fraction != null ? Math.round(row.fraction * 100) : null;
	const reset = row ? resetText(row, now, tx) : null;
	const state = row?.state === "reached" ? tx("usage.limits.state.reached") : row?.state === "near" ? tx("usage.limits.state.near") : null;
	const share = row && percent !== null ? shareText(row, percent, tx) : null;
	const meta = share === null ? [tx("usage.limits.noFigure")] : [share, reset].filter((part): part is string => part !== null);

	return (
		<div className="grid min-h-9 grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 py-1.5 @min-[32rem]/usage-glance:grid-cols-[6rem_minmax(7.5rem,15rem)_minmax(0,1fr)] @min-[32rem]/usage-glance:py-0">
			<span className="truncate text-md font-medium text-fg" title={name}>
				{name}
			</span>
			{row && row.fraction !== null ? (
				<Meter
					fraction={row.fraction}
					label={tx("usage.plan.meterLabel", { provider: name })}
					valueText={[share, reset].filter(Boolean).join(", ")}
					tone={row.tone === "ok" ? "accent" : row.tone}
				/>
			) : (
				<span aria-hidden className="h-1.5 rounded-full bg-border-strong" />
			)}
			<span className="col-start-2 min-w-0 text-sm text-fg-muted tabular-nums @min-[32rem]/usage-glance:col-start-3 @min-[32rem]/usage-glance:text-right">
				{state && row && <span className={cn("font-medium", stateInks[row.tone])}>{state} · </span>}
				{/* Each phrase wraps as a whole in a narrow column ("Resets in 2h 20m" never splits); lines break at the dots. */}
				{meta.map((part, index) => (
					<Fragment key={part}>
						{index > 0 && " · "}
						<span className="whitespace-nowrap">{part}</span>
					</Fragment>
				))}
			</span>
		</div>
	);
}
