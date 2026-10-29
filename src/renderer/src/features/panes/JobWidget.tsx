import { ArrowDown, ArrowRight, ArrowUp } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn, Progress } from "../../ui";
import { Chart } from "../../ui/Chart";
import { type JobWidgetBlock, type JobWidgetView, type WidgetTone, type WidgetValue, widgetChart } from "./jobWidgets";

const TONE: Record<WidgetTone, string> = { success: "text-ok", warning: "text-warn", error: "text-err", info: "text-fg", pending: "text-warn", muted: "text-fg-muted", neutral: "text-fg-muted", accent: "text-accent", user: "text-fg" };
function Value({ item }: { item: WidgetValue }) {
	const { t } = useTranslation("panes");
	const Trend = item.trend?.direction === "down" ? ArrowDown : item.trend?.direction === "up" ? ArrowUp : ArrowRight;
	return (
		<span className={cn("inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5", item.tone && TONE[item.tone])}>
			{item.label && <span className="text-fg-muted">{item.label}</span>}
			<span className="break-words font-mono tabular-nums">{item.text}</span>
			{item.trend && (
				<span className={cn("inline-flex items-center gap-0.5 text-xs", item.trend.tone ? TONE[item.trend.tone] : "text-fg-muted")}>
					<Trend className="size-3" aria-hidden />
					{(item.trend.direction === "up" || item.trend.direction === "down") && (
						<span className="sr-only">{t(item.trend.direction === "up" ? "tasks.job.trendUp" : "tasks.job.trendDown")}{" "}</span>
					)}
					{item.trend.text}
				</span>
			)}
		</span>
	);
}

function ChartBlock({ block }: { block: Extract<JobWidgetBlock, { kind: "spark" | "bars" }> }) {
	const spec = useMemo(() => widgetChart(block), [block]);
	const { t } = useTranslation("panes");
	const domain = block.kind === "spark"
		? block.min !== null && block.max !== null ? { min: block.min, max: block.max } : undefined
		: block.max !== null ? { min: 0, max: block.max } : undefined;
	return (
		<div className="space-y-1">
			<Chart spec={spec} domain={domain} label={block.label} />
			<details className="text-xs text-fg-muted">
				<summary className="w-fit cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-ring">
					{t("tasks.job.chartData")}
				</summary>
				<div className="max-h-60 overflow-auto">
					<table className="w-full text-left">
						<thead>
							<tr>
								<th className="px-2 py-1 font-medium">{block.label || t("tasks.job.sample")}</th>
								<th className="px-2 py-1 font-medium">{t("tasks.job.value")}</th>
							</tr>
						</thead>
						<tbody>
							{spec.categories.map((category, index) => (
								<tr key={index} className="border-t border-border">
									<td className="px-2 py-1">{block.kind === "spark" ? block.tips[index] || category : category}</td>
									<td className="px-2 py-1 font-mono tabular-nums">{spec.series[0]?.points[index]?.text}</td>
								</tr>
							))}
						</tbody>
						{block.kind === "spark" && block.marks.length > 0 && (
							<tfoot>
								{block.marks.map((mark, index) => (
									<tr key={index} className="border-t border-border">
										<th scope="row" className="px-2 py-1 font-medium">{mark.label || t("tasks.job.target")}</th>
										<td className="px-2 py-1 font-mono tabular-nums">{mark.value}</td>
									</tr>
								))}
							</tfoot>
						)}
					</table>
				</div>
			</details>
		</div>
	);
}

function WidgetBlock({ block }: { block: JobWidgetBlock }) {
	const { t } = useTranslation("panes");
	switch (block.kind) {
		case "spark":
		case "bars":
			return <ChartBlock block={block} />;
		case "meter":
			return (
				<div className="space-y-1">
					<p className={cn("flex flex-wrap justify-between gap-x-2", block.tone && TONE[block.tone])}>
						<span>{block.label}</span>
						<span className="font-mono tabular-nums">{block.text}</span>
					</p>
					<Progress
						value={block.value * 100}
						aria-label={block.label || t("tasks.job.progress")}
						aria-valuetext={block.text}
						tone={block.tone === "success" ? "ok" : block.tone === "warning" ? "warn" : block.tone === "error" ? "err" : "accent"}
					/>
				</div>
			);
		case "stat":
			return (
				<dl className="flex flex-wrap gap-x-4 gap-y-2">
					{block.items.map((item, index) => (
						<div key={index}>
							<dt className="sr-only">{item.label}</dt>
							<dd><Value item={item} /></dd>
						</div>
					))}
				</dl>
			);
		case "grid":
			return (
				<div>
					<p className="mb-1 text-fg-muted">{block.label}</p>
					<dl className="grid grid-cols-[repeat(auto-fit,minmax(100px,1fr))] gap-2">
						{block.items.map((item, index) => (
							<div key={index} className={cn("min-w-0 rounded-sm bg-panel px-2 py-1", item.tone && TONE[item.tone])}>
								<dt className="break-words text-xs text-fg-muted">{item.label}</dt>
								<dd className="break-words">{item.text}</dd>
							</div>
						))}
					</dl>
				</div>
			);
		case "text":
			return <p className="whitespace-pre-wrap break-words text-fg-muted">{block.text}</p>;
	}
}

/** omp's headline is useful in the collapsed row; the expanded view retains every supported widget block. */
export function JobWidget({ widget, headlineOnly = false }: { widget: JobWidgetView; headlineOnly?: boolean }) {
	if (headlineOnly) return widget.headline ? <span className="text-xs text-fg"><Value item={widget.headline} /></span> : null;
	return (
		<div className="min-w-0 space-y-3 text-sm text-fg">
			{widget.title && <p className="font-medium">{widget.title}</p>}
			{widget.headline && <Value item={widget.headline} />}
			{widget.stage && <p className="break-words text-fg-muted">{widget.stage}</p>}
			{widget.blocks.map((block, index) => (
				<div key={index} className="min-w-0">
					<WidgetBlock block={block} />
				</div>
			))}
		</div>
	);
}
