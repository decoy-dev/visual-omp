/**
 * Usage & limits → Plan limits (DESIGN §4.18): one white card with a row per provider. A collapsed row
 * names the binding window (the one the status bar would show, across the provider's accounts) with
 * its account, meter, percent, reset and state; other windows near or at their limit, stopped sign-ins
 * and accounts without figures stay listed under it. Opening the row shows every account and window.
 */
import { CaretRight, Gauge, Question, Warning, WarningCircle } from "@phosphor-icons/react";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNow } from "@/shell/hooks";
import { openSettings } from "@/state/navigation";
import { Button, cn, EmptyState, Expand, Meter, Notice, SectionHeader, Skeleton, StatusBadge, type StatusBadgeTone, Tooltip } from "@/ui";
import { focusRing, focusRingInset } from "@/ui/styles";
import { formatAge, formatDuration } from "../format";
import { checkUsageLimits, refreshUsageLimits, useUsageLimits, useUsageLimitsStatus } from "./limitsStore";
import { type AccountLimits, type AccountRow, type LimitRow, planLimits, type ProviderLimits, providerName, providerSummary } from "./planUsage";
import { useUsageView } from "./viewStore";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const stateInks: Record<LimitRow["tone"], string> = { ok: "text-fg-muted", warn: "text-warn", err: "text-err" };

/** "5-hour limit", "7-day limit", "Monthly limit", else omp's label. */
function rowName(row: LimitRow, t: TFunction<"extensions">): string {
	const ms = row.durationMs;
	if (ms !== null && ms > 0) {
		if (ms % DAY_MS === 0) return t("usage.limits.window.day", { n: ms / DAY_MS });
		if (ms % HOUR_MS === 0) return t("usage.limits.window.hour", { n: ms / HOUR_MS });
		if (ms % MINUTE_MS === 0) return t("usage.limits.window.minute", { n: ms / MINUTE_MS });
	}
	return row.monthly ? t("usage.limits.window.monthly") : row.label;
}

/** "Resets in 2h", "Regen in 2h", "Awaiting updated usage" once the reset passed, or null without a reset. */
function resetText(row: LimitRow, now: number, t: TFunction<"extensions">): string | null {
	if (row.resetsAt === null) return null;
	if (row.resetsAt <= now) return t("usage.limits.awaiting");
	const time = formatDuration(row.resetsAt - now);
	return row.resetLabel ? t("usage.limits.resetVerbIn", { verb: row.resetLabel[0].toUpperCase() + row.resetLabel.slice(1), time }) : t("usage.limits.resetsIn", { time });
}

const accountName = (account: AccountLimits, t: TFunction<"extensions">) => account.name ?? t("usage.limits.unnamedAccount");

export function PlanLimitsSection() {
	const { t, i18n } = useTranslation("extensions");
	const snapshot = useUsageLimits(true);
	const status = useUsageLimitsStatus();
	const now = useNow(30_000);
	// Opening the page reads omp's cached figures right away (joining a read already running).
	useEffect(() => {
		void refreshUsageLimits();
	}, []);
	const providers = useMemo(() => (snapshot ? planLimits(snapshot) : []), [snapshot]);
	const oldest = snapshot ? Math.min(snapshot.generatedAt, ...snapshot.reports.map(report => report.fetchedAt)) : null;
	const retry = (
		<Button size="sm" onClick={() => void checkUsageLimits()} loading={status.checking}>
			{t("common.retry")}
		</Button>
	);

	return (
		<section aria-labelledby="usage-limits-title" aria-busy={status.checking}>
			<SectionHeader id="usage-limits-title" title={t("usage.limits.title")} description={t("usage.limits.description")} />
			<p className="mb-stack text-sm text-fg-muted">{t("usage.limits.scope")}</p>
			<p role="status" className="sr-only">
				{status.checking ? t("usage.limits.checking") : ""}
			</p>

			{snapshot && status.error && !status.checking && (
				<Notice tone="warn" actions={retry} className="mb-4">
					{t("usage.limits.staleFailed", { age: formatAge(oldest ?? snapshot.generatedAt, now, i18n.language) })} {status.error}
				</Notice>
			)}

			{!snapshot ? (
				status.error && !status.checking ? (
					<Notice tone="err" actions={retry}>
						{t("usage.limits.failed")} {status.error}
					</Notice>
				) : (
					<div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-panel">
						{[0, 1].map(index => (
							<div key={index} className="flex items-center gap-4 p-card">
								<Skeleton width={120} height={16} />
								<Skeleton height={8} className="flex-1" />
							</div>
						))}
					</div>
				)
			) : providers.length === 0 ? (
				<div className="rounded-lg border border-border bg-panel">
					<EmptyState icon={<Gauge />} title={t("usage.limits.none")} body={t("usage.limits.noneBody")} className="py-8" />
				</div>
			) : (
				<>
					<div className="@container/limits flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel">
						{providers.map(provider => (
							<ProviderRow key={provider.provider} provider={provider} now={now} />
						))}
					</div>
					<p className="mt-3 text-xs text-fg-faint">{t("usage.limits.thresholds")}</p>
				</>
			)}
		</section>
	);
}

/** Window name with its tier or model, plus the account when the provider has several or names one. */
function windowCaption({ account, row }: AccountRow, named: boolean, t: TFunction<"extensions">): string {
	const window = row.qualifier ? `${rowName(row, t)}, ${row.qualifier}` : rowName(row, t);
	return named ? `${window} · ${accountName(account, t)}` : window;
}

function ProviderRow({ provider, now }: { provider: ProviderLimits; now: number }) {
	const { t } = useTranslation("extensions");
	const open = useUsageView(state => state.expanded.has(provider.provider));
	const setExpanded = useUsageView(state => state.setExpanded);
	const summary = useMemo(() => providerSummary(provider), [provider]);
	const name = providerName(provider.provider);
	const named = provider.accounts.length > 1 || provider.accounts.some(account => account.name !== null);
	const { binding } = summary;
	const row = binding?.row ?? null;
	const percent = row?.fraction != null ? Math.round(row.fraction * 100) : null;
	const reset = row ? resetText(row, now, t) : null;
	// A provider without a usable figure names the window it reports, if any, and reads "Unknown".
	const unknownRow = binding ? undefined : summary.unknown.flatMap(account => account.rows.map((entry): AccountRow => ({ account, row: entry })))[0];
	const badge: { tone: StatusBadgeTone; label: string } | null =
		row?.state === "reached"
			? { tone: "err", label: t("usage.limits.state.reached") }
			: row?.state === "near"
				? { tone: "warn", label: t("usage.limits.state.near") }
				: null;
	const regionId = `usage-limits-${provider.provider}`;
	const reporting = provider.accounts.filter(account => account.kind === "report").length;

	const alerts: { key: string; tone: "warn" | "err" | "neutral"; text: string }[] = open
		? []
		: [
				...summary.disabled.flatMap(account =>
					account.disabled.map(credential => ({
						key: `disabled:${credential.id}`,
						tone: "warn" as const,
						text: t("usage.limits.alert.disabled", { account: accountName(account, t), cause: credential.cause }),
					})),
				),
				...summary.alerts.map(alert => ({
					key: `${alert.account.key}:${alert.row.id}`,
					tone: alert.row.state === "reached" ? ("err" as const) : ("warn" as const),
					// A provider can report a window near or at its limit without a figure; that never reads as 0% used.
					text:
						alert.row.fraction === null
							? t("usage.limits.alert.rowUnknown", {
									window: windowCaption(alert, named, t),
									state: t(`usage.limits.state.${alert.row.state === "reached" ? "reached" : "near"}`),
								})
							: t("usage.limits.alert.row", {
									window: windowCaption(alert, named, t),
									state: t(`usage.limits.state.${alert.row.state === "reached" ? "reached" : "near"}`),
									percent: Math.round(alert.row.fraction * 100),
								}),
				})),
				...summary.unknown
					.filter(account => !unknownRow || account.key !== unknownRow.account.key)
					.map(account => ({
						key: `unknown:${account.key}`,
						tone: "neutral" as const,
						text: t("usage.limits.alert.unknown", { account: accountName(account, t) }),
					})),
			];

	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={regionId}
				onClick={() => setExpanded(provider.provider, !open)}
				className={cn(
					"grid w-full items-center gap-x-3 gap-y-2 px-card py-3 text-left transition-colors duration-(--dur-fast) hover:bg-hover",
					"grid-cols-[auto_minmax(0,1fr)_auto] [grid-template-areas:'caret_name_badge'_'._meter_meter'_'._info_info']",
					"@min-[46rem]/limits:grid-cols-[auto_minmax(10rem,15rem)_minmax(0,1fr)_14rem_8rem] @min-[46rem]/limits:[grid-template-areas:'caret_name_meter_info_badge']",
					focusRingInset,
				)}
			>
				<CaretRight aria-hidden className={cn("size-4 text-fg-muted transition-transform duration-(--dur-fast) [grid-area:caret]", open && "rotate-90")} />
				<span className="flex min-w-0 flex-col [grid-area:name]">
					<span className="text-md font-semibold text-fg">{name}</span>
					<span className="truncate text-sm text-fg-muted">
						{binding ? windowCaption(binding, named, t) : unknownRow ? windowCaption(unknownRow, named, t) : t("usage.limits.noFigure")}
					</span>
				</span>
				<span aria-hidden className="min-w-0 [grid-area:meter]">
					{row && row.fraction !== null && (
						<Meter fraction={row.fraction} label={name} valueText="" tone={row.tone === "ok" ? "accent" : row.tone} />
					)}
				</span>
				<span className="flex min-w-0 items-baseline gap-3 text-sm tabular-nums [grid-area:info] @min-[46rem]/limits:justify-end">
					<span className={cn("font-medium", row === null ? "text-fg-muted" : row.tone === "ok" ? "text-fg" : stateInks[row.tone])}>
						{percent === null ? t("usage.limits.unknown") : t("usage.limits.used", { percent })}
					</span>
					{reset && <span className="truncate text-fg-muted">{reset}</span>}
				</span>
				<span className="justify-self-end [grid-area:badge]">{badge && <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}</span>
			</button>
			{alerts.length > 0 && (
				<ul className="flex flex-col gap-1 pb-3 pl-11 pr-card text-sm">
					{alerts.map(alert => (
						<li key={alert.key} className="flex items-start gap-2">
							<AlertGlyph tone={alert.tone} />
							<span className="text-fg-muted [overflow-wrap:anywhere]">{alert.text}</span>
						</li>
					))}
				</ul>
			)}
			<Expand open={open} id={regionId}>
				<div className="flex flex-col pb-card pl-11 pr-card">
					{reporting > 1 && <p className="pb-3 text-sm text-fg-muted">{t("usage.limits.pooled", { count: reporting })}</p>}
					<div className="flex flex-col divide-y divide-border">
						{provider.accounts.map(account => (
							<Account key={account.key} account={account} provider={name} named={provider.accounts.length > 1} now={now} />
						))}
					</div>
				</div>
			</Expand>
		</div>
	);
}

function AlertGlyph({ tone }: { tone: "warn" | "err" | "neutral" }): ReactNode {
	const className = "mt-0.5 size-3.5 shrink-0";
	if (tone === "err") return <WarningCircle aria-hidden weight="fill" className={cn(className, "text-err")} />;
	if (tone === "warn") return <Warning aria-hidden weight="fill" className={cn(className, "text-warn")} />;
	return <Question aria-hidden className={cn(className, "text-fg-faint")} />;
}

function Account({ account, provider, named, now }: { account: AccountLimits; provider: string; named: boolean; now: number }) {
	const { t, i18n } = useTranslation("extensions");
	const showIdentity = account.name !== null || named;
	return (
		<div className="flex flex-col gap-3 py-4 first:pt-1 last:pb-0">
			{(showIdentity || account.fetchedAt !== null) && (
				<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					{showIdentity ? (
						<div className="min-w-0">
							<p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{accountName(account, t)}</p>
							{account.detail && <p className="text-xs text-fg-muted [overflow-wrap:anywhere]">{account.detail}</p>}
						</div>
					) : (
						<span />
					)}
					{account.fetchedAt !== null && (
						<span className="text-xs text-fg-faint">{t("usage.limits.checked", { age: formatAge(account.fetchedAt, now, i18n.language) })}</span>
					)}
				</div>
			)}

			{account.disabled.map(credential => (
				<Notice
					key={credential.id}
					tone="warn"
					actions={
						<Button size="sm" onClick={() => openSettings("providers")}>
							{t("usage.limits.manageProviders")}
						</Button>
					}
				>
					{t("usage.limits.disabled", { cause: credential.cause })}
				</Notice>
			))}

			{account.notes.map(note => (
				<p key={note} className="text-sm text-fg-muted">
					{note}
				</p>
			))}

			{account.kind === "unavailable" && (
				<p className="text-sm">
					<span className="font-medium text-fg">{t("usage.limits.state.unavailable")}</span>{" "}
					<span className="text-fg-muted">{t("usage.limits.unavailableBody")}</span>
				</p>
			)}
			{account.kind === "report" && account.rows.length === 0 && <p className="text-sm text-fg-muted">{t("usage.limits.noRows")}</p>}

			{account.rows.length > 0 && (
				<ul className="flex flex-col gap-4">
					{account.rows.map(row => (
						<LimitRowView key={row.id} row={row} provider={provider} now={now} />
					))}
				</ul>
			)}

			<details className="group text-xs text-fg-faint">
				<summary className={cn("w-fit cursor-pointer rounded-sm hover:text-fg-muted", focusRing)}>{t("usage.limits.technical")}</summary>
				<dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
					{account.ids.map(id => (
						<div key={`${id.key}:${id.value}`} className="contents">
							<dt>{t(`usage.limits.id.${id.key}`)}</dt>
							<dd className="font-mono [overflow-wrap:anywhere]">{id.value}</dd>
						</div>
					))}
				</dl>
			</details>
		</div>
	);
}

function LimitRowView({ row, provider, now }: { row: LimitRow; provider: string; now: number }) {
	const { t, i18n } = useTranslation("extensions");
	const name = rowName(row, t);
	const percent = row.fraction === null ? null : Math.round(row.fraction * 100);
	const used = percent === null ? null : t("usage.limits.used", { percent });
	const passed = row.resetsAt !== null && row.resetsAt <= now;
	const reset = resetText(row, now, t);
	const exact =
		row.resetsAt === null
			? null
			: new Intl.DateTimeFormat(i18n.language, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(row.resetsAt);
	const stateText = row.state === "ok" ? null : t(`usage.limits.state.${row.state}`);
	const label = row.qualifier ? `${provider} ${name}, ${row.qualifier}` : `${provider} ${name}`;
	return (
		<li className="flex flex-col gap-2">
			<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
				<span className="text-md text-fg">{name}</span>
				{row.qualifier && <span className="text-sm text-fg-muted [overflow-wrap:anywhere]">{row.qualifier}</span>}
				{stateText && <span className={cn("ml-auto text-sm font-medium", row.state === "unavailable" ? "text-fg-muted" : stateInks[row.tone])}>{stateText}</span>}
			</div>
			{(used || reset) && (
				<p className="text-sm tabular-nums text-fg-muted">
					{used}
					{used && reset && " · "}
					{reset && exact && (
						<Tooltip content={t(passed ? "usage.limits.resetWasDue" : "usage.limits.resetsAt", { date: exact })}>
							<time tabIndex={0} dateTime={new Date(row.resetsAt ?? 0).toISOString()} className={cn("rounded-sm", passed && "text-fg", focusRing)}>
								{reset}
							</time>
						</Tooltip>
					)}
				</p>
			)}
			{row.fraction !== null && (
				<Meter
					fraction={row.fraction}
					label={label}
					valueText={[used, stateText, reset].filter(Boolean).join(", ")}
					tone={row.tone === "ok" ? "accent" : row.tone}
				/>
			)}
			{row.notes.map(note => (
				<p key={note} className="text-xs text-fg-faint">
					{note}
				</p>
			))}
		</li>
	);
}
