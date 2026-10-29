import { useMemo } from "react";
import type { ChartProps } from "../Chart";
import { renderChartSvg } from "./render-chart";

export default function ChartView({ spec, domain, label, className = "" }: ChartProps) {
	const html = useMemo(() => renderChartSvg(spec, domain), [spec, domain]);
	return <div className={`vomp-chart ${className}`} role={label ? "img" : undefined} aria-label={label} dangerouslySetInnerHTML={{ __html: html }} />;
}
