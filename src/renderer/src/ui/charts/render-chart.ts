import type { ChartSpec } from "./vendor/omp/chart-plan";
import { renderChartSvg as renderOmpChartSvg } from "./vendor/omp/chart-svg";
import { renderDomainChart, type ChartDomain } from "./domain-chart";

/** Preserve omp's geometry and labels while following the app's flat-fill design rule. */
export function renderChartSvg(spec: ChartSpec, domain?: ChartDomain): string {
	const sameUnit = spec.series.every(series => series.dim === spec.series[0]?.dim && series.unit === spec.series[0]?.unit);
	if ((domain && (spec.kind === "line" || spec.kind === "bar")) || (sameUnit && spec.kind === "line" && spec.annotations?.some(annotation => annotation.kind === "reference"))) return renderDomainChart(spec, domain);
	return renderOmpChartSvg(spec)
		.replace(/<defs><linearGradient id="fade-[^"]+"[\s\S]*?<\/linearGradient><\/defs>/g, "")
		.replace(/fill="url\(#fade-([\w-]+)\)"/g, 'fill="var(--$1)" fill-opacity="0.12"');
}
