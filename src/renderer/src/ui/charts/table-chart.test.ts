import { describe, expect, it } from "vitest";
import { tableChart } from "./table-chart";
import { analyzeTable, parseCell } from "./vendor/omp/table-data";
import { buildChart, planChart } from "./vendor/omp/chart-plan";
import { renderChartSvg } from "./render-chart";
import type { ChartKind, ChartSpec } from "./vendor/omp/chart-plan";

const rows = [["A", "10"], ["B", "20"], ["C", "50"], ["D", "80"]];

describe("omp table charts", () => {
	it("charts useful numeric comparisons with an accessible name and theme colors", () => {
		const svg = tableChart(["Model", "Tokens"], rows);
		expect(svg).toContain('<svg');
		expect(svg).toContain('role="img"');
		expect(svg).toMatch(/aria-label="[^"]+"/);
		expect(svg).toContain("var(--c1)");
	});

	it("keeps small, constant, index and prose tables as tables", () => {
		expect(tableChart(["Model", "Tokens"], rows.slice(0, 1))).toBeNull();
		expect(tableChart(["Model", "Tokens"], rows.map(([name]) => [name, "20"]))).toBeNull();
		expect(tableChart(["#", "File"], [["1", "a.ts"], ["2", "b.ts"], ["3", "c.ts"], ["4", "d.ts"]])).toBeNull();
		expect(tableChart(["Name", "Status"], [["A", "ready"], ["B", "done"]])).toBeNull();
	});

	it("draws omp's comparison chart for two conditions with a notable change", () => {
		expect(tableChart(["Model", "Tokens"], rows.slice(0, 2))).toContain("comparison chart");
	});

	it("normalizes quantities and excludes total rows from the plotted scale", () => {
		expect(parseCell("**1.5 ms**")).toMatchObject({ kind: "number", value: 0.0015, dim: "duration", emphasis: true });
		expect(parseCell("2 KiB")).toMatchObject({ kind: "number", value: 2048, dim: "bytes" });
		const table = analyzeTable(["Model", "Tokens"], [...rows, ["Total", "160"]]);
		expect(table.rows).toHaveLength(4);
		expect(table.totals).toEqual([4]);
		const plan = planChart(table);
		expect(plan).toBeDefined();
		expect(buildChart(table, plan!)?.categories).not.toContain("Total");
	});

	it("keeps mixed measurement units on separate axes", () => {
		const table = analyzeTable(["Model", "Cost", "Latency"], rows.map(([name, value]) => [name, `$${value}`, `${value} ms`]));
		const plan = planChart(table);
		expect(plan?.kind).toBe("multiples");
		expect(buildChart(table, plan!)?.series.map(series => series.dim)).toEqual(["currency", "duration"]);
	});

	it("escapes source labels in chart markup", () => {
		const svg = tableChart(["Model", "Tokens"], rows.map(([name, value]) => [`<script>${name}</script>`, value]));
		expect(svg).not.toContain("<script>");
	});
});

const kinds: ChartKind[] = ["bar", "paired", "grouped", "line", "heatmap", "multiples", "share", "diverging", "scatter", "change", "progress", "stacked", "timeline", "waterfall", "dots", "range", "slope", "butterfly", "bullet", "ladder", "histogram", "stat"];
it.each(kinds)("draws the full %s chart form", kind => {
	const series = ["Before", "After"].map((name, index) => ({ name, dim: "count" as const, unit: "", notes: [undefined, undefined, undefined, undefined], points: [1, 3, 6, 10].map(value => ({ value: value + index, text: String(value + index), emphasis: false, upper: value + index + 2 })) }));
	const spec: ChartSpec = { kind, categories: ["A", "B", "C", "D"], axis: "Model", series, x: { name: "Run", dim: "count", unit: "", values: [1, 2, 3, 4] }, targets: series[0].points, ladders: [{ name: "Latency", series: [0, 1] }] };
	expect(renderChartSvg(spec)).toContain("<svg");
	expect(renderChartSvg(spec)).not.toContain("<linearGradient");
});
