import { lazy, Suspense } from "react";
import type { ChartSpec } from "./charts/vendor/omp/chart-plan";
import type { ChartDomain } from "./charts/domain-chart";
import "./rich-content.css";

export type { ChartSpec, ChartPoint, ChartSeries } from "./charts/vendor/omp/chart-plan";
export interface ChartProps {
	spec: ChartSpec;
	domain?: ChartDomain;
	label?: string;
	className?: string;
}
const ChartView = lazy(() => import("./charts/ChartView"));

/** Full chart view. Callers retain their accessible data table or textual values beside it. */
export function Chart(props: ChartProps) {
	return <Suspense fallback={null}><ChartView {...props} /></Suspense>;
}
