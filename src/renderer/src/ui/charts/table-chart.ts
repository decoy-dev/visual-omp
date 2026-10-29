import { analyzeTable } from "./vendor/omp/table-data";
import { buildChart, planChart, worthCharting } from "./vendor/omp/chart-plan";
import { renderChartSvg } from "./render-chart";

/** omp 18.14's local qualification, planning and chart kinds. Never invokes a judge model. */
export function tableChart(header: readonly string[], rows: readonly (readonly string[])[]): string | null {
	const table = analyzeTable(header, rows);
	const plan = planChart(table);
	if (!plan) return null;
	const spec = buildChart(table, plan);
	return spec && worthCharting(spec) ? renderChartSvg(spec) : null;
}
