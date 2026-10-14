/**
 * Usage & limits page (DESIGN §4.18), white cards on the gray page canvas: plan limits first, then usage
 * omp recorded on this computer over the last 7 or 30 local days (key figures, daily estimated API cost
 * beside its split by project, chats), then what the figures include and a link to omp's own stats
 * page. Each section loads and fails on its own, so a slow provider never holds up local usage.
 */
import { ArrowSquareOut, ArrowsClockwise, CaretRight, ChartBar } from "@phosphor-icons/react";
import type { SpendSummary } from "@shared/contracts/extensions";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PageProps } from "@/registry/slots";
import { type UsagePageProps, usePageBack } from "@/state/navigation";
import { Button, cn, Definition, EmptyState, KpiStrip, Notice, PageFrame, PageHeader, SectionHeader, Segmented, ShareBar, Skeleton, toast } from "@/ui";
import { focusRing } from "@/ui/styles";
import { errorText, formatCount, formatUsd } from "../format";
import { type Loaded, useLoad } from "../shared";
import { ChatsTable } from "./ChatsTable";
import { checkUsageLimits, useUsageLimits, useUsageLimitsStatus } from "./limitsStore";
import { costByProject, projectName, topProjects, type UsageRange } from "./model";
import { PlanLimitsSection } from "./PlanLimits";
import { SpendChart } from "./SpendChart";
import { usageMemory, useUsageView } from "./viewStore";

/** Project rows before the rest fold into one. */
const PROJECT_ROWS = 6;

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
			<PageHeader
				title={t("usage.title")}
				description={t("usage.subtitle")}
				actions={
					<Button
						icon={<ArrowsClockwise />}
						loading={limitsStatus.checking || spend.loading}
						onClick={() => {
							void checkUsageLimits();
							void spend.reload();
						}}
					>
						{t("usage.refresh")}
					</Button>
				}
			/>
			<div className="flex flex-col gap-section">
				<PlanLimitsSection />
				<RecordedUsageSection range={range} spend={spend} data={data} />
				<PageFoot />
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
	const period = t(range === 7 ? "usage.recorded.range7" : "usage.recorded.range30");
	const retry = (
		<Button size="sm" onClick={() => void spend.reload()} loading={spend.loading}>
			{t("common.retry")}
		</Button>
	);
	const figures = (totals: SpendSummary["totals"] | null) => [
		{
			id: "chats",
			label: <Definition content={t("usage.recorded.kpi.chats")}>{t("usage.recorded.chats")}</Definition>,
			value: totals && formatCount(totals.chats),
			hint: period,
		},
		{
			id: "tokens",
			label: <Definition content={t("usage.recorded.kpi.tokens")}>{t("usage.recorded.tokens")}</Definition>,
			value: totals && formatCount(totals.tokens),
			hint: t("usage.recorded.tokensHint"),
		},
		{
			id: "cost",
			label: <Definition content={t("usage.recorded.costHint")}>{t("usage.recorded.cost")}</Definition>,
			value: totals && formatUsd(totals.cost),
			hint: t("usage.recorded.costSub"),
		},
	];

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
			<p className="mb-4 flex flex-wrap gap-x-3 gap-y-1 text-sm text-fg-muted">
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
					<div className="flex flex-col gap-4">
						<KpiStrip label={t("usage.recorded.statsLabel")} items={figures(null)} />
						<Skeleton height={300} className="rounded-lg" />
						<Skeleton height={200} className="rounded-lg" />
					</div>
				)
			) : empty ? (
				<div className="rounded-lg border border-border bg-panel">
					<EmptyState icon={<ChartBar />} title={t("usage.recorded.empty")} body={t("usage.recorded.emptyBody")} className="py-10" />
				</div>
			) : (
				<div className="flex flex-col gap-4">
					<KpiStrip label={t("usage.recorded.statsLabel")} items={figures(data.totals)} />
					<CostCards data={data} range={range} />
					<ChatsTable chats={data.chats} days={data.days} />
				</div>
			)}
		</section>
	);
}

/** The daily chart, and beside it the period's cost by project when more than one project has a cost. */
function CostCards({ data, range }: { data: SpendSummary; range: UsageRange }) {
	const { t } = useTranslation("extensions");
	const setFilters = useUsageView(state => state.setFilters);
	const projects = useMemo(() => costByProject(data.chats), [data.chats]);
	const split = projects.filter(project => project.cost > 0).length > 1;
	const { shown, rest } = topProjects(projects, PROJECT_ROWS);
	// Folders that share a name ("api" twice) show their parent folder too.
	const label = (cwd: string) => {
		const name = projectName(cwd);
		const clash = projects.some(other => other.cwd !== cwd && projectName(other.cwd) === name);
		return clash ? `${projectName(cwd.slice(0, cwd.replace(/[\\/]+$/, "").length - name.length))}/${name}` : name;
	};
	const items = [
		...shown.map(project => ({ id: project.cwd, label: label(project.cwd), title: project.cwd, value: project.cost, display: formatUsd(project.cost) })),
		...(rest ? [{ id: "rest", label: t("usage.projects.other", { count: rest.count }), value: rest.cost, display: formatUsd(rest.cost), rest: true }] : []),
	];
	const showProject = (cwd: string) => {
		setFilters({ project: cwd });
		const heading = document.getElementById("usage-chats-title");
		heading?.focus({ preventScroll: true });
		heading?.scrollIntoView({ block: "start" });
	};

	return (
		<div className={cn("grid grid-cols-1 gap-4", split && "@min-[56rem]/content:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]")}>
			<section aria-labelledby="usage-chart-title" className="min-w-0 rounded-lg border border-border bg-panel p-card">
				<h3 id="usage-chart-title" className="text-md font-semibold text-fg">
					{t("usage.chart.title")}
				</h3>
				<SpendChart key={range} days={data.days} titleId="usage-chart-title" />
			</section>
			{split && (
				<section aria-labelledby="usage-projects-title" className="flex min-w-0 flex-col rounded-lg border border-border bg-panel px-row pb-row pt-card">
					<h3 id="usage-projects-title" className="px-row text-md font-semibold text-fg">
						{t("usage.projects.title")}
					</h3>
					<p className="mt-1 px-row text-sm text-fg-muted">{t("usage.projects.description")}</p>
					<ShareBar
						label={t("usage.projects.title")}
						items={items}
						onSelect={showProject}
						selectLabel={item => t("usage.projects.show", { project: item.title ?? "", cost: formatUsd(item.value) })}
						className="mt-3"
					/>
				</section>
			)}
		</div>
	);
}

/** What the figures include, and omp's own stats dashboard in the browser (a separate tool, so nothing here carries over). */
function PageFoot() {
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
		<footer className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4 border-t border-border pt-card">
			<details className="group min-w-0 flex-1 basis-80 text-sm">
				<summary className={cn("flex w-fit cursor-pointer list-none items-center gap-2 rounded-sm py-1 text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden", focusRing)}>
					<CaretRight aria-hidden className="size-3.5 transition-transform duration-(--dur-fast) group-open:rotate-90" />
					{t("usage.recorded.definitions")}
				</summary>
				<ul className="mt-2 flex list-disc flex-col gap-1 pl-10 text-fg-muted">
					<li>{t("usage.recorded.definition.tokens")}</li>
					<li>{t("usage.recorded.definition.subagents")}</li>
					<li>{t("usage.recorded.definition.cost")}</li>
					<li>{t("usage.recorded.definition.model")}</li>
					<li>{t("usage.recorded.definition.time")}</li>
					<li>{t("usage.recorded.definition.days")}</li>
					<li>{t("usage.recorded.definition.limits")}</li>
				</ul>
			</details>
			<div className="flex max-w-sm flex-col items-start gap-1 @min-[56rem]/content:items-end @min-[56rem]/content:text-right">
				<Button variant="ghost" iconRight={<ArrowSquareOut />} loading={opening} onClick={() => void open()} className="-mx-2.5">
					{t("usage.openStats")}
				</Button>
				<p className="text-xs text-fg-faint">{t("usage.openStatsNote")}</p>
			</div>
		</footer>
	);
}
