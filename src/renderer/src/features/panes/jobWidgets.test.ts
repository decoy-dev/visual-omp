import { describe, expect, it } from "vitest";
import { completionPercentOf, jobWidgetOf, widgetChart } from "./jobWidgets";

describe("completionPercentOf", () => {
	it("retains zero and one hundred as estimates, rejecting unavailable or invalid values", () => {
		expect([0, 42.5, 100].map(completionPercentOf)).toEqual([0, 42.5, 100]);
		expect([undefined, null, "40", NaN, Infinity, -1, 101].map(completionPercentOf)).toEqual([null, null, null, null, null, null, null]);
	});
});

describe("jobWidgetOf", () => {
	it("reads every supported widget block and the upstream trend text shape", () => {
		const widget = jobWidgetOf({ title: "Build", headline: { label: "Tests", text: "182", trend: { text: "▲ 15%", tone: "success" } }, stage: "Running integration tests", blocks: [
			{ kind: "spark", label: "Tests per second", values: [1, 4, 2], min: 0, max: 10, last: "2/s", tips: ["10:00:00", "10:00:01", "10:00:02"], marks: [{ value: 5, label: "Target" }] },
			{ kind: "bars", label: "Suites", items: [{ label: "Unit", value: 50, text: "50 tests", tone: "success" }], max: 100 },
			{ kind: "meter", label: "Complete", value: 0.5, text: "50/100" },
			{ kind: "stat", items: [{ label: "Failed", text: "1", trend: { text: "▼ 3.2%", tone: "error" } }] },
			{ kind: "grid", label: "Workers", items: [{ label: "A", text: "pending", tone: "pending" }] },
			{ kind: "text", text: "Checking compatibility" },
		] });
		expect(widget?.blocks.map(block => block.kind)).toEqual(["spark", "bars", "meter", "stat", "grid", "text"]);
		expect(widget?.headline?.trend).toEqual({ direction: "up", text: "15%", tone: "success" });
		expect(widget?.blocks[3]).toMatchObject({ items: [{ trend: { direction: "down", text: "3.2%", tone: "error" } }] });
	});
	it("ignores malformed blocks and clamps fraction meters without inventing values", () => {
		expect(jobWidgetOf(null)).toBeNull();
		const widget = jobWidgetOf({ blocks: [null, { kind: "other" }, { kind: "meter", value: NaN }, { kind: "meter", value: 2 }, { kind: "bars", items: [null, { label: "x", value: "3", text: "3" }] }] });
		expect(widget?.blocks).toMatchObject([{ kind: "meter", value: 1 }, { kind: "bars", items: [] }]);
	});
	it("keeps each valid spark value paired with its own tooltip", () => {
		const block = jobWidgetOf({ blocks: [{ kind: "spark", values: [1, NaN, 3], tips: ["first", "invalid", "third"] }] })?.blocks[0];
		expect(block).toMatchObject({ values: [1, 3], tips: ["first", "third"] });
	});
});

describe("widgetChart", () => {
	it("maps every spark sample, tooltip, last-value label and target into a full line chart", () => {
		const raw = { kind: "spark", label: "Throughput", values: [1, 2, 3, 4, 5, 6], last: "6 req/s", tips: ["t1", "t2", "t3", "t4", "t5", "t6"], marks: [{ value: 8, label: "Target" }] };
		const block = jobWidgetOf({ blocks: [raw] })?.blocks[0];
		if (!block || block.kind !== "spark") throw new Error("Spark missing");
		const spec = widgetChart(block);
		expect(spec.kind).toBe("line");
		expect(spec.categories).toEqual(raw.tips);
		expect(spec.series[0]?.points.map(point => point?.value)).toEqual(raw.values);
		expect(spec.series[0]?.notes).toEqual(raw.tips);
		expect(spec.series[0]?.points.at(-1)?.text).toBe("6 req/s");
		expect(spec.annotations).toEqual([{ kind: "reference", value: 8, label: "Target" }]);
	});
	it("keeps all bar categories with their formatted values", () => {
		const block = jobWidgetOf({ blocks: [{ kind: "bars", label: "Workers", items: [{ label: "A", value: 25, text: "25 req" }, { label: "B", value: 40, text: "40 req", tone: "success" }] }] })?.blocks[0];
		if (!block || block.kind !== "bars") throw new Error("Bars missing");
		const spec = widgetChart(block);
		expect(spec.categories).toEqual(["A", "B"]);
		expect(spec.series[0]?.points).toEqual([{ value: 25, text: "25 req", emphasis: false }, { value: 40, text: "40 req", emphasis: true }]);
	});
});
