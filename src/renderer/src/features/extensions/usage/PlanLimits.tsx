/** Usage & limits → Plan limits (DESIGN §4.18): every account omp knows, grouped by provider. */
import { ArrowsClockwise, Gauge } from "@phosphor-icons/react";
import type { TFunction } from "i18next";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNow } from "@/shell/hooks";
import { openSettings } from "@/state/navigation";
import { Button, cn, EmptyState, Meter, Notice, SectionHeader, Skeleton, Tooltip } from "@/ui";
import { focusRing } from "@/ui/styles";
import { formatAge, formatDuration } from "../format";
import { checkUsageLimits, refreshUsageLimits, useUsageLimits, useUsageLimitsStatus } from "./limitsStore";
import { type AccountLimits, type LimitRow, planLimits, type ProviderLimits, providerName } from "./planUsage";

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
	const refresh = () => void checkUsageLimits();
	const oldest = snapshot ? Math.min(snapshot.generatedAt, ...snapshot.reports.map(report => report.fetchedAt)) : null;
	const retry = (
		<Button size="sm" onClick={refresh} loading={status.checking}>
			{t("common.retry")}
		</Button>
	);

	return (
		<section aria-labelledby="usage-limits-title" aria-busy={status.checking}>
			<SectionHeader
				id="usage-limits-title"
				title={t("usage.limits.title")}
				description={t("usage.limits.description")}
				actions={
					<Button size="sm" icon={<ArrowsClockwise />} loading={status.checking} onClick={refresh}>
						{t("usage.limits.refresh")}
					</Button>
				}
			/>
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
					<div className="flex flex-col gap-3">
						<Skeleton width={120} height={16} />
						<Skeleton height={44} />
						<Skeleton height={44} />
					</div>
				)
			) : providers.length === 0 ? (
				<EmptyState icon={<Gauge />} title={t("usage.limits.none")} body={t("usage.limits.noneBody")} className="py-6" />
			) : (
				<div className="flex flex-col gap-8">
					{providers.map(provider => (
						<ProviderGroup key={provider.provider} provider={provider} now={now} />
					))}
					<p className="text-xs text-fg-faint">{t("usage.limits.thresholds")}</p>
				</div>
			)}
		</section>
	);
}

function ProviderGroup({ provider, now }: { provider: ProviderLimits; now: number }) {
	const { t } = useTranslation("extensions");
	const name = providerName(provider.provider);
	const reporting = provider.accounts.filter(account => account.kind === "report").length;
	return (
		<div className="flex flex-col">
			<h3 className="text-md font-semibold text-fg">{name}</h3>
			{reporting > 1 && <p className="mt-0.5 text-sm text-fg-muted">{t("usage.limits.pooled", { count: reporting })}</p>}
			<div className="mt-3 flex flex-col divide-y divide-border">
				{provider.accounts.map(account => (
					<Account key={account.key} account={account} provider={name} named={provider.accounts.length > 1} now={now} />
				))}
			</div>
		</div>
	);
}

function Account({ account, provider, named, now }: { account: AccountLimits; provider: string; named: boolean; now: number }) {
	const { t, i18n } = useTranslation("extensions");
	const showIdentity = account.name !== null || named;
	return (
		<div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
			{(showIdentity || account.fetchedAt !== null) && (
				<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					{showIdentity ? (
						<div className="min-w-0">
							<p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{account.name ?? t("usage.limits.unnamedAccount")}</p>
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
	let reset: string | null = null;
	if (row.resetsAt !== null) {
		const time = formatDuration(row.resetsAt - now);
		reset = passed
			? t("usage.limits.awaiting")
			: row.resetLabel
				? t("usage.limits.resetVerbIn", { verb: row.resetLabel[0].toUpperCase() + row.resetLabel.slice(1), time })
				: t("usage.limits.resetsIn", { time });
	}
	const exact =
		row.resetsAt === null
			? null
			: new Intl.DateTimeFormat(i18n.language, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(row.resetsAt);
	const stateText = row.state === "ok" ? null : t(`usage.limits.state.${row.state}`);
	const label = row.qualifier ? `${provider} ${name}, ${row.qualifier}` : `${provider} ${name}`;
	return (
		<li className="flex flex-col gap-1.5">
			<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
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
