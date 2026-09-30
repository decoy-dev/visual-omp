/** DESIGN §4.18 — Usage & limits dashboard. */
import { ArrowDown, ArrowUp, ChartColumn, Download, ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpendChat, SpendDay } from "@shared/contracts/extensions";
import type { UsageLimitsSnapshot, UsageReport } from "@shared/contracts/usage";
import type { SheetProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import { Button, Chip, cn, EmptyState, IconButton, Progress, Skeleton, toast, Tooltip } from "@/ui";
import { focusRing, focusRingInset } from "@/ui/styles";
import { errorText, formatCount, formatDuration, formatUsd } from "../format";
import { type ExtensionSheetProps, ExtensionSheetFrame, Notice, useLoad } from "../shared";
import { type ChatSortKey, chatsCsv, limitTone, promptTokens, type SortDirection, sortChats, usedFraction } from "./model";

const DAYS = 7;

export function UsageSheet({ close }: SheetProps<ExtensionSheetProps>) {
	const { t, i18n } = useTranslation("extensions");
	const spend = useLoad(() => window.vomp.invoke("extensions:spend", DAYS), []);
	const limits = useLimits();
	const [openingStats, setOpeningStats] = useState(false);

	const exportCsv = async () => {
		if (!spend.data) return;
		try {
			const saved = await window.vomp.invoke("extensions:saveText", {
				title: t("usage.exportCsv"),
				defaultName: `omp-usage-${spend.data.days.at(-1)?.date ?? "week"}.csv`,
				content: chatsCsv(spend.data.chats, t("usage.untitled")),
				filters: [{ name: "CSV", extensions: ["csv"] }],
			});
			if (saved) toast({ tone: "ok", message: t("usage.toast.exported"), action: { label: t("common.showInFolder"), onClick: () => void window.vomp.invoke("app:showItem", saved) } });
		} catch (err) {
			toast({ tone: "err", message: t("usage.toast.exportFailed"), description: errorText(err) });
		}
	};

	const openStats = async () => {
		setOpeningStats(true);
		try {
			await window.vomp.invoke("extensions:statsDashboard");
		} catch (err) {
			toast({ tone: "err", message: t("usage.toast.statsFailed"), description: errorText(err) });
		} finally {
			setOpeningStats(false);
		}
	};

	const today = spend.data?.days.at(-1);
	const hasUsage = (spend.data?.totals.requests ?? 0) > 0;
	return (
		<ExtensionSheetFrame
			close={close}
			width={880}
			title={t("usage.title")}
			description={t("usage.subtitle")}
			bodyClassName="flex flex-col gap-6"
			footer={
				<>
					<Button icon={<Download />} onClick={() => void exportCsv()} disabled={!spend.data?.chats.length} className="mr-auto">
						{t("usage.exportCsv")}
					</Button>
					<Button variant="ghost" iconRight={<ExternalLink />} loading={openingStats} onClick={() => void openStats()}>
						{t("usage.openStats")}
					</Button>
				</>
			}
		>
			{spend.error && <Notice tone="err">{t("usage.spendFailed")} {spend.error}</Notice>}

			<section aria-label={t("usage.statsLabel")} className="grid grid-cols-4 gap-3">
				<StatCard label={t("usage.stat.today")} value={spend.data ? formatUsd(today?.cost ?? 0) : null} />
				<StatCard label={t("usage.stat.week")} value={spend.data ? formatUsd(spend.data.totals.cost) : null} />
				<StatCard label={t("usage.stat.chats")} value={spend.data ? String(spend.data.totals.chats) : null} />
				<StatCard label={t("usage.stat.tokens")} value={spend.data ? formatCount(spend.data.totals.tokens) : null} />
			</section>

			{spend.data && !hasUsage ? (
				<EmptyState icon={<ChartColumn />} title={t("usage.empty")} />
			) : (
				<section aria-labelledby="usage-chart-title" className="flex flex-col gap-2">
					<h3 id="usage-chart-title" className="text-sm font-semibold text-fg-muted">
						{t("usage.chartTitle")}
					</h3>
					{spend.data ? <BarChart days={spend.data.days} locale={i18n.language} /> : <Skeleton height={140} />}
				</section>
			)}

			<LimitsSection limits={limits} locale={i18n.language} />

			{spend.data && spend.data.chats.length > 0 && <ChatTable chats={spend.data.chats} close={close} />}
			{spend.data && <p className="text-xs text-fg-faint">{t("usage.estimateNote")}</p>}
		</ExtensionSheetFrame>
	);
}

function StatCard({ label, value }: { label: string; value: string | null }) {
	return (
		<div className="flex h-[88px] flex-col justify-center gap-1 rounded-lg border border-border bg-panel px-4">
			{value === null ? (
				<Skeleton width={96} height={28} />
			) : (
				<span className="text-[28px] font-bold leading-none tracking-[-0.02em] text-fg tabular-nums">{value}</span>
			)}
			<span className="text-xs text-fg-muted">{label}</span>
		</div>
	);
}

/** 7-day bars: `--accent-2`, today `--accent`, baseline hairline, exact $ on hover/focus. */
function BarChart({ days, locale }: { days: SpendDay[]; locale: string }) {
	const { t } = useTranslation("extensions");
	const max = Math.max(...days.map(day => day.cost), 0);
	const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
	const longDate = new Intl.DateTimeFormat(locale, { weekday: "long", month: "short", day: "numeric" });
	return (
		<div className="flex flex-col">
			<ul className="flex h-32 items-end justify-around border-b border-border px-2" aria-label={t("usage.chartTitle")}>
				{days.map((day, index) => {
					const isToday = index === days.length - 1;
					const text = t("usage.barLabel", { date: longDate.format(day.start), cost: formatUsd(day.cost), requests: day.requests });
					return (
						<li key={day.date} className="flex h-full flex-1 items-end justify-center">
							<Tooltip content={text}>
								<button
									type="button"
									aria-label={text}
									className={cn(
										"w-6 rounded-t-sm transition-[height,filter] duration-(--dur) ease-(--ease-out) hover:brightness-110 motion-reduce:transition-none",
										isToday ? "bg-accent" : "bg-accent-2",
										day.cost === 0 && "bg-border-strong",
										focusRing,
									)}
									style={{ height: max > 0 && day.cost > 0 ? `${Math.max(3, (day.cost / max) * 100)}%` : "2px" }}
								/>
							</Tooltip>
						</li>
					);
				})}
			</ul>
			<div className="flex justify-around px-2 pt-1.5" aria-hidden>
				{days.map((day, index) => (
					<span key={day.date} className={cn("flex-1 text-center text-xs", index === days.length - 1 ? "font-semibold text-fg" : "text-fg-faint")}>
						{index === days.length - 1 ? t("usage.today") : weekday.format(day.start)}
					</span>
				))}
			</div>
		</div>
	);
}

interface LimitsState {
	data: UsageLimitsSnapshot | null;
	error: string | null;
	loading: boolean;
	refresh(): void;
}

/** Provider limits; a failed refresh keeps the last good snapshot and says how old it is. */
function useLimits(): LimitsState {
	const [refreshCount, setRefreshCount] = useState(0);
	const [last, setLast] = useState<UsageLimitsSnapshot | null>(null);
	const load = useLoad(async () => {
		const snapshot = await window.vomp.invoke("usage:limits", { refresh: refreshCount > 0 });
		setLast(snapshot);
		return snapshot;
	}, [refreshCount]);
	return { data: load.data ?? last, error: load.error, loading: load.loading, refresh: () => setRefreshCount(n => n + 1) };
}

function LimitsSection({ limits, locale }: { limits: LimitsState; locale: string }) {
	const { t } = useTranslation("extensions");
	const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
	const reports = limits.data?.reports.filter(report => report.limits.length > 0) ?? [];
	return (
		<section aria-labelledby="usage-limits-title" className="flex flex-col gap-3">
			<div className="flex items-center gap-2">
				<h3 id="usage-limits-title" className="text-sm font-semibold text-fg-muted">
					{t("usage.limitsTitle")}
				</h3>
				{limits.error && limits.data && (
					<Tooltip content={limits.error}>
						<span tabIndex={0} className={cn("rounded-full", focusRing)}>
							<Chip tone="neutral">{t("usage.asOf", { time: time.format(limits.data.generatedAt) })}</Chip>
						</span>
					</Tooltip>
				)}
				<IconButton
					size="sm"
					className="ml-auto"
					label={t("usage.refreshLimits")}
					icon={<RefreshCw className={cn(limits.loading && "vo-spin")} />}
					disabled={limits.loading}
					onClick={limits.refresh}
				/>
			</div>
			{limits.error && !limits.data && <Notice tone="warn">{t("usage.limitsFailed")} {limits.error}</Notice>}
			{limits.data?.disabledCredentials.map(credential => (
				<Notice key={credential.id} tone="warn">
					{t("usage.disabledCredential", { provider: credential.provider, account: credential.email ?? credential.orgName ?? "", cause: credential.cause })}
				</Notice>
			))}
			{!limits.data && limits.loading ? (
				<Skeleton height={96} />
			) : limits.data && reports.length === 0 ? (
				<EmptyState title={t("usage.noLimits")} body={t("usage.noLimitsBody")} className="py-4" />
			) : (
				reports.map(report => <ReportCard key={`${report.provider}:${String(report.metadata?.accountId ?? "")}`} report={report} />)
			)}
		</section>
	);
}

function ReportCard({ report }: { report: UsageReport }) {
	const { t } = useTranslation("extensions");
	const account = [report.metadata?.email, report.metadata?.orgName].filter(value => typeof value === "string" && value).join(" · ");
	return (
		<div className="rounded-lg border border-border bg-panel p-4">
			<div className="mb-3 flex items-baseline gap-2">
				<span className="text-md font-semibold text-fg">{report.provider}</span>
				{account && <span className="truncate text-xs text-fg-faint">{account}</span>}
			</div>
			<ul className="flex flex-col gap-3">
				{report.limits.map(limit => {
					const fraction = usedFraction(limit);
					const tone = limitTone(fraction, limit.status);
					const resetsAt = limit.window?.resetsAt;
					const until = resetsAt ? formatDuration(resetsAt - Date.now()) : null;
					const atLimit = limit.status === "exhausted" || (fraction ?? 0) >= 1;
					return (
						<li key={`${limit.id}:${limit.label}`} className="flex flex-col gap-1.5">
							<div className="flex items-baseline gap-2 text-sm">
								<span className="min-w-0 flex-1 truncate text-fg">{limit.label}</span>
								{fraction !== null && <span className="font-mono text-xs tabular-nums text-fg-muted">{t("usage.used", { percent: Math.round(fraction * 100) })}</span>}
								{until && (
									<span className={cn("text-xs", atLimit ? "font-medium text-err" : "text-fg-faint")}>
										{t(atLimit ? "usage.atLimit" : "usage.resetsIn", { time: until })}
									</span>
								)}
							</div>
							{fraction === null ? (
								<Progress aria-label={limit.label} tone={tone} />
							) : (
								<Progress aria-label={limit.label} value={fraction * 100} tone={tone} />
							)}
						</li>
					);
				})}
			</ul>
			{report.notes?.map(note => (
				<p key={note} className="mt-2 text-xs text-fg-faint">
					{note}
				</p>
			))}
		</div>
	);
}

const COLUMNS: { key: ChatSortKey; align: "left" | "right" }[] = [
	{ key: "title", align: "left" },
	{ key: "model", align: "left" },
	{ key: "inputTokens", align: "right" },
	{ key: "outputTokens", align: "right" },
	{ key: "cost", align: "right" },
	{ key: "durationMs", align: "right" },
];

function ChatTable({ chats, close }: { chats: SpendChat[]; close(): void }) {
	const { t } = useTranslation("extensions");
	const [sort, setSort] = useState<{ key: ChatSortKey; direction: SortDirection }>({ key: "cost", direction: "desc" });
	const rows = sortChats(chats, sort.key, sort.direction);
	const open = async (chat: SpendChat) => {
		const known = (await window.vomp.invoke("sessions:list", chat.cwd)).find(session => session.file === chat.file);
		useApp.getState().openSession(
			known ?? {
				id: chat.id,
				file: chat.file,
				cwd: chat.cwd,
				title: chat.title,
				createdAt: chat.createdAt || chat.firstAt,
				updatedAt: chat.lastAt,
				parentSession: null,
				preview: null,
				archived: false,
			},
		);
		close();
	};
	return (
		<section aria-labelledby="usage-chats-title" className="flex flex-col gap-2">
			<h3 id="usage-chats-title" className="text-sm font-semibold text-fg-muted">
				{t("usage.chatsTitle")}
			</h3>
			<div className="max-h-[360px] overflow-auto rounded-lg border border-border bg-panel">
				<table className="w-full table-fixed border-collapse text-sm">
					<colgroup>
						<col />
						<col className="w-[150px]" />
						<col className="w-[84px]" />
						<col className="w-[84px]" />
						<col className="w-[80px]" />
						<col className="w-[80px]" />
					</colgroup>
					<thead className="sticky top-0 z-(--z-sticky) bg-panel">
						<tr className="border-b border-border">
							{COLUMNS.map(column => {
								const active = sort.key === column.key;
								const Arrow = sort.direction === "asc" ? ArrowUp : ArrowDown;
								return (
									<th
										key={column.key}
										scope="col"
										aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
										className={cn("px-3 py-2 font-medium text-fg-muted", column.align === "right" ? "text-right" : "text-left")}
									>
										<button
											type="button"
											className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-sm hover:text-fg", active && "text-fg", focusRing)}
											onClick={() =>
												setSort(prev => ({
													key: column.key,
													direction: prev.key === column.key ? (prev.direction === "asc" ? "desc" : "asc") : column.align === "right" ? "desc" : "asc",
												}))
											}
										>
											{t(`usage.column.${column.key}`)}
											{active && <Arrow aria-hidden className="size-3" />}
										</button>
									</th>
								);
							})}
						</tr>
					</thead>
					<tbody>
						{rows.map(chat => (
							<tr key={chat.file} className="border-b border-border last:border-0 hover:bg-hover">
								<td className="px-3 py-1.5">
									<button type="button" onClick={() => void open(chat)} className={cn("block w-full truncate rounded-sm text-left text-fg", focusRingInset)} title={chat.title ?? undefined}>
										{chat.title ?? t("usage.untitled")}
									</button>
								</td>
								<td className="truncate px-3 py-1.5 font-mono text-xs text-fg-muted" title={chat.model ?? undefined}>
									{chat.model?.split("/").pop() ?? "—"}
								</td>
								<td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-fg-muted">{formatCount(promptTokens(chat))}</td>
								<td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-fg-muted">{formatCount(chat.outputTokens)}</td>
								<td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-fg">{formatUsd(chat.cost)}</td>
								<td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-fg-muted">{formatDuration(chat.durationMs)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
