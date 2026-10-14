/**
 * Usage & limits page (DESIGN §4.18): plan limits first, then usage omp recorded on this computer over
 * the last 7 or 30 local days (summary, daily estimated API cost, chats), then a link to omp's own
 * stats page. Each section loads and fails on its own, so a slow provider never holds up local usage.
 */
import { ArrowSquareOut, ChartBar } from "@phosphor-icons/react";
import type { SpendSummary } from "@shared/contracts/extensions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PageProps } from "@/registry/slots";
import { type UsagePageProps, usePageBack } from "@/state/navigation";
import { Button, cn, EmptyState, Notice, PageFrame, PageHeader, SectionHeader, Segmented, Skeleton, StatList, toast } from "@/ui";
import { focusRing } from "@/ui/styles";
import { errorText, formatCount, formatUsd } from "../format";
import { type Loaded, useLoad } from "../shared";
import { ChatsTable } from "./ChatsTable";
import { useUsageLimits, useUsageLimitsStatus } from "./limitsStore";
import type { UsageRange } from "./model";
import { PlanLimitsSection } from "./PlanLimits";
import { SpendChart } from "./SpendChart";
import { usageMemory, useUsageView } from "./viewStore";

/**
 * The page returns to the scroll position of the last visit once both sections show content (or
 * their error), so the restored position lands on the same rows. The last summary shows at once
 * while the page reads a fresh one.
 */
export function UsagePage({ seq, close }: PageProps<UsagePageProps>) {
	const { t } = useTranslation("extensions");
	const back = usePageBack(close);
	const range = useUsageView(state => state.range);
	const spend = useLoad(async () => {
		const summary = await window.vomp.invoke("extensions:spend", range);
		usageMemory.spend = summary;
		return summary;
	}, [range]);
	// A summary of another range (the previous one, while the new one loads) never shows under this range.
	const latest = spend.data ?? usageMemory.spend;
	const data = latest?.days.length === range ? latest : null;
	const limits = useUsageLimits(true);
	const limitsStatus = useUsageLimitsStatus();
	const ready = (data !== null || spend.error !== null) && (limits !== null || (limitsStatus.error !== null && !limitsStatus.checking));
	return (
		<PageFrame
			back={back}
			width="data"
			label={t("usage.title")}
			focusKey={seq}
			scrollMemory={{
				top: usageMemory.scrollTop,
				ready,
				save: top => {
					usageMemory.scrollTop = top;
				},
			}}
		>
			<PageHeader title={t("usage.title")} description={t("usage.subtitle")} />
			<div className="flex flex-col gap-12">
				<PlanLimitsSection />
				<RecordedUsageSection range={range} spend={spend} data={data} />
				<StatsLink />
			</div>
		</PageFrame>
	);
}

function RecordedUsageSection({ range, spend, data }: { range: UsageRange; spend: Loaded<SpendSummary>; data: SpendSummary | null }) {
	const { t, i18n } = useTranslation("extensions");
	const setRange = useUsageView(state => state.setRange);

	const dateFormat = new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric", year: "numeric" });
	const end = data?.days.at(-1)?.start ?? new Date().setHours(0, 0, 0, 0);
	const start = data?.days[0]?.start ?? new Date(end).setDate(new Date(end).getDate() - (range - 1));
	const empty = data !== null && data.totals.requests === 0;
	const retry = (
		<Button size="sm" onClick={() => void spend.reload()} loading={spend.loading}>
			{t("common.retry")}
		</Button>
	);

	return (
		<section aria-labelledby="usage-recorded-title" aria-busy={spend.loading} className="flex flex-col">
			<SectionHeader
				id="usage-recorded-title"
				title={t("usage.recorded.title")}
				description={t("usage.recorded.description")}
				actions={
					<Segmented<`${UsageRange}`>
						aria-label={t("usage.recorded.rangeLabel")}
						size="sm"
						value={`${range}`}
						onValueChange={value => setRange(value === "30" ? 30 : 7)}
						options={[
							{ value: "7", label: t("usage.recorded.range7") },
							{ value: "30", label: t("usage.recorded.range30") },
						]}
					/>
				}
				className="mb-2"
			/>
			<p className="mb-6 flex flex-wrap gap-x-3 gap-y-1 text-sm text-fg-muted">
				<span>{t("usage.recorded.dates", { start: dateFormat.format(start), end: dateFormat.format(end) })}</span>
				<span aria-hidden>·</span>
				<span>{t("usage.recorded.localTime")}</span>
				<span aria-hidden>·</span>
				<span>{t("usage.recorded.scope")}</span>
			</p>

			{spend.error &&
				(data ? (
					<Notice tone="warn" actions={retry} className="mb-4">
						{t("usage.recorded.staleFailed")} {spend.error}
					</Notice>
				) : (
					<Notice tone="err" actions={retry}>
						{t("usage.recorded.failed")} {spend.error}
					</Notice>
				))}
			{data && data.skippedFiles > 0 && (
				<Notice tone="warn" className="mb-4">
					{t("usage.recorded.partial", { count: data.skippedFiles })}
				</Notice>
			)}

			{!data ? (
				!spend.error && (
					<div className="flex flex-col gap-8">
						<StatList
							label={t("usage.recorded.statsLabel")}
							items={[
								{ id: "chats", label: t("usage.recorded.chats"), value: null },
								{ id: "tokens", label: t("usage.recorded.tokens"), value: null },
								{ id: "cost", label: t("usage.recorded.cost"), value: null },
							]}
						/>
						<Skeleton height={240} />
						<Skeleton height={160} />
					</div>
				)
			) : empty ? (
				<EmptyState icon={<ChartBar />} title={t("usage.recorded.empty")} body={t("usage.recorded.emptyBody")} className="py-6" />
			) : (
				<div className="flex flex-col gap-10">
					<div className="flex flex-col gap-3">
						<StatList
							label={t("usage.recorded.statsLabel")}
							items={[
								{ id: "chats", label: t("usage.recorded.chats"), value: formatCount(data.totals.chats) },
								{ id: "tokens", label: t("usage.recorded.tokens"), value: formatCount(data.totals.tokens), hint: t("usage.recorded.tokensHint") },
								{ id: "cost", label: t("usage.recorded.cost"), value: formatUsd(data.totals.cost), hint: t("usage.recorded.costHint") },
							]}
						/>
						<details className="text-sm">
							<summary className={cn("w-fit cursor-pointer rounded-sm text-fg-muted hover:text-fg", focusRing)}>{t("usage.recorded.definitions")}</summary>
							<ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-fg-muted">
								<li>{t("usage.recorded.definition.tokens")}</li>
								<li>{t("usage.recorded.definition.subagents")}</li>
								<li>{t("usage.recorded.definition.model")}</li>
								<li>{t("usage.recorded.definition.time")}</li>
								<li>{t("usage.recorded.definition.days")}</li>
							</ul>
						</details>
					</div>
					<SpendChart key={range} days={data.days} />
					<ChatsTable chats={data.chats} days={data.days} />
				</div>
			)}
		</section>
	);
}

/** omp's own stats dashboard in the browser; a separate tool, so nothing here carries over. */
function StatsLink() {
	const { t } = useTranslation("extensions");
	const [opening, setOpening] = useState(false);
	const open = async () => {
		setOpening(true);
		try {
			await window.vomp.invoke("extensions:statsDashboard");
		} catch (err) {
			toast({ tone: "err", message: t("usage.toast.statsFailed"), description: errorText(err) });
		} finally {
			setOpening(false);
		}
	};
	return (
		<div className="flex flex-col items-start gap-1 border-t border-border pt-6">
			<Button variant="ghost" iconRight={<ArrowSquareOut />} loading={opening} onClick={() => void open()} className="-ml-2.5">
				{t("usage.openStats")}
			</Button>
			<p className="text-sm text-fg-muted">{t("usage.openStatsNote")}</p>
		</div>
	);
}
