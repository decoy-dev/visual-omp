import type { ChartSpec } from "../../ui/Chart";
import { isRecord, num, str } from "../../tool-render/util";

export type WidgetTone = "success" | "warning" | "error" | "info" | "pending" | "muted" | "neutral" | "accent" | "user";
export interface WidgetTrend { direction: string; text: string; tone?: WidgetTone }
export interface WidgetValue { label: string; text: string; tone?: WidgetTone; trend?: WidgetTrend }
export type JobWidgetBlock =
	| { kind: "spark"; label: string; values: number[]; min: number | null; max: number | null; last: string; tips: string[]; marks: { value: number; label: string; tone?: WidgetTone }[]; tone?: WidgetTone }
	| { kind: "bars"; label: string; items: (WidgetValue & { value: number })[]; max: number | null }
	| { kind: "meter"; label: string; value: number; text: string; tone?: WidgetTone }
	| { kind: "stat"; items: WidgetValue[] }
	| { kind: "grid"; label: string; items: WidgetValue[] }
	| { kind: "text"; text: string };
export interface JobWidgetView { title: string; headline: WidgetValue | null; stage: string | null; blocks: JobWidgetBlock[] }

function tone(value: unknown): WidgetTone | undefined {
	return typeof value === "string" && ["success", "warning", "error", "info", "pending", "muted", "neutral", "accent", "user"].includes(value) ? value as WidgetTone : undefined;
}
function valueOf(raw: unknown): WidgetValue | null {
	if (!isRecord(raw)) return null;
	const text = str(raw.text);
	if (text === null) return null;
	const trend = isRecord(raw.trend) ? raw.trend : null;
	const trendText = str(trend?.text) ?? "";
	return {
		label: str(raw.label) ?? "",
		text,
		tone: tone(raw.tone),
		...(trend ? {
			trend: {
				direction: trendText.startsWith("▼") ? "down" : trendText.startsWith("▲") ? "up" : "",
				text: trendText.replace(/^[▲▼]\s*/, ""),
				tone: tone(trend.tone),
			},
		} : {}),
	};
}
function blockOf(raw: unknown): JobWidgetBlock[] {
	if (!isRecord(raw)) return [];
	const label = str(raw.label) ?? "";
	const items = Array.isArray(raw.items) ? raw.items : [];
	switch (raw.kind) {
		case "spark": {
			const tips = Array.isArray(raw.tips) ? raw.tips : [];
			const samples = Array.isArray(raw.values) ? raw.values.flatMap((value, index) => {
				const number = num(value);
				return number !== null ? [{ value: number, tip: str(tips[index]) ?? "" }] : [];
			}) : [];
			const marks = Array.isArray(raw.marks) ? raw.marks.flatMap(mark => {
				if (!isRecord(mark)) return [];
				const value = num(mark.value);
				return value !== null ? [{ value, label: str(mark.label) ?? "", tone: tone(mark.tone) }] : [];
			}) : [];
			return [{
				kind: "spark", label, values: samples.map(sample => sample.value), tips: samples.map(sample => sample.tip),
				min: num(raw.min), max: num(raw.max), last: str(raw.last) ?? "", tone: tone(raw.tone), marks,
			}];
		}
		case "bars":
			return [{
				kind: "bars", label, max: num(raw.max),
				items: items.flatMap(item => {
					const value = valueOf(item);
					const number = isRecord(item) ? num(item.value) : null;
					return value && number !== null ? [{ ...value, value: number }] : [];
				}),
			}];
		case "meter": {
			const value = num(raw.value);
			return value === null ? [] : [{ kind: "meter", label, value: Math.max(0, Math.min(1, value)), text: str(raw.text) ?? "", tone: tone(raw.tone) }];
		}
		case "stat":
		case "grid": {
			const values = items.flatMap(item => {
				const value = valueOf(item);
				return value ? [value] : [];
			});
			return raw.kind === "stat" ? [{ kind: "stat", items: values }] : [{ kind: "grid", label, items: values }];
		}
		case "text": return [{ kind: "text", text: str(raw.text) ?? "" }];
		default: return [];
	}
}
/** Read omp's rendered widget view, never the model-authored extraction spec. Saved job/wait results carry this same shape. */
export function jobWidgetOf(raw: unknown): JobWidgetView | null {
	if (!isRecord(raw)) return null;
	return { title: str(raw.title) ?? "", headline: valueOf(raw.headline), stage: str(raw.stage), blocks: Array.isArray(raw.blocks) ? raw.blocks.flatMap(blockOf) : [] };
}

/**
 * Keep only charts beneath helper cards; omit textual widget summaries and counters to avoid the extra between-card
 * text. Null when the widget has no charts.
 */
export function helperWidgetCharts(widget: JobWidgetView | null | undefined): JobWidgetView | null {
	const blocks = widget?.blocks.filter(block => block.kind === "spark" || block.kind === "bars" || block.kind === "meter") ?? [];
	return blocks.length > 0 ? { title: "", headline: null, stage: null, blocks } : null;
}

/** Self-estimates remain estimates; missing, invalid and out-of-range values never imply completion. */
export function completionPercentOf(value: unknown): number | null {
	const percent = num(value);
	return percent !== null && percent >= 0 && percent <= 100 ? percent : null;
}

/** Keep every point and target when upgrading omp's compact spark/bar block to a full chart. */
export function widgetChart(block: Extract<JobWidgetBlock, { kind: "spark" | "bars" }>): ChartSpec {
	const spark = block.kind === "spark";
	const categories = spark ? block.values.map((_, index) => block.tips[index] || String(index + 1)) : block.items.map(item => item.label);
	return {
		kind: spark ? "line" : "bar",
		axis: block.label,
		categories,
		series: [{
			name: block.label,
			dim: "count",
			unit: "",
			points: spark
				? block.values.map((value, index) => ({ value, text: index === block.values.length - 1 && block.last ? block.last : String(value), emphasis: false }))
				: block.items.map(item => ({ value: item.value, text: item.text, emphasis: item.tone === "success" })),
			notes: spark ? block.tips : block.items.map(() => undefined),
		}],
		...(spark ? { x: { name: "", dim: "count", unit: "", values: block.values.map((_, index) => index + 1) }, annotations: block.marks.map(mark => ({ kind: "reference" as const, value: mark.value, label: mark.label })) } : {}),
	};
}
