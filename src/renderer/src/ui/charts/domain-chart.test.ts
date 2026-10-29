import { describe, expect, it } from "vitest";
import { chartDomain } from "./domain-chart";
import { renderChartSvg } from "./render-chart";
import type { ChartSpec } from "./vendor/omp/chart-plan";

function spec(kind: "line" | "bar" = "line"): ChartSpec {
	return { kind, axis: "Sample", categories: ["1", "2", "3"], series: [{ name: "Requests", dim: "count", unit: "", notes: [undefined, undefined, undefined], points: [3, 8, 14].map(value => ({ value, text: String(value), emphasis: false })) }] };
}

describe("explicit widget chart domains", () => {
	it("includes a target outside the current data without inventing a data point", () => {
		const chart = { ...spec(), annotations: [{ kind: "reference" as const, value: 16, label: "Target" }] };
		expect(chartDomain(chart)).toEqual({ min: 0, max: 16 });
		const svg = renderChartSvg(chart, { min: 0, max: 20 });
		expect(svg).toContain("Target · 16");
		expect(svg).toContain('stroke-dasharray="4 4"');
		expect(svg.match(/<circle/g)).toHaveLength(3);
	});

	it("retains widget domain bounds while including observed values outside them", () => {
		expect(chartDomain(spec(), { min: 5, max: 20 })).toEqual({ min: 3, max: 20 });
		expect(chartDomain(spec(), { min: 0, max: 10 })).toEqual({ min: 0, max: 14 });
	});

	it("keeps a positive single-value domain finite", () => {
		const chart = { ...spec(), series: [] };
		expect(chartDomain(chart, { min: 20, max: 20 })).toEqual({ min: 20, max: 21 });
		expect(renderChartSvg(chart, { min: 20, max: 20 })).not.toMatch(/NaN|Infinity/);
	});

	it("uses the declared bar maximum instead of stretching its largest current value to fill", () => {
		const chart = spec("bar");
		const current = renderChartSvg(chart, { min: 0, max: 14 });
		const bounded = renderChartSvg(chart, { min: 0, max: 28 });
		expect(current).toContain('width="458"');
		expect(bounded).toContain('width="229"');
	});

	it("escapes source-provided titles and target labels", () => {
		const chart = { ...spec(), title: '<img src=x onerror="alert(1)">', annotations: [{ kind: "reference" as const, value: 16, label: "<script>" }] };
		expect(renderChartSvg(chart)).not.toMatch(/<img|<script/);
	});
});
