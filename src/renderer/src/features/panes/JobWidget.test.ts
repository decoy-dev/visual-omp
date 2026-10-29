// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import "../../i18n";
import { JobWidget } from "./JobWidget";
import { jobWidgetOf } from "./jobWidgets";

describe("job widget accessible content", () => {
	it("keeps both trend directions in rendered text outside the decorative arrows", () => {
		const widget = jobWidgetOf({ headline: { text: "50 tests", trend: { text: "▼ 50%", tone: "success" } }, blocks: [{ kind: "stat", items: [{ label: "Throughput", text: "12/s", trend: { text: "▲ 20%", tone: "success" } }] }] });
		if (!widget) throw new Error("Missing widget");
		const container = document.createElement("div");
		container.innerHTML = renderToStaticMarkup(createElement(JobWidget, { widget }));
		for (const direction of ["Up", "Down"]) {
			const text = [...container.querySelectorAll(".sr-only")].find(element => element.textContent?.trim() === direction);
			expect(text).toBeDefined();
			expect(text!.closest('[aria-hidden="true"]')).toBeNull();
		}
		expect(container.textContent).toContain("Down 50%");
		expect(container.textContent).toContain("Up 20%");
	});

	it("renders every target label and value in the chart-data table outside the chart image", () => {
		const widget = jobWidgetOf({ blocks: [{ kind: "spark", label: "Throughput", values: [2, 4], tips: ["first", "second"], marks: [{ value: 16, label: "Target requests/s" }, { value: 8.5, label: "Minimum requests/s" }, { value: 20 }] }] });
		if (!widget) throw new Error("Missing widget");
		const container = document.createElement("div");
		container.innerHTML = renderToStaticMarkup(createElement(JobWidget, { widget }));
		const disclosure = container.querySelector("details")!;
		disclosure.open = true;
		expect(disclosure.querySelector("summary")?.textContent?.trim()).toBe("Show chart data");
		const rows = [...disclosure.querySelectorAll("tfoot tr")];
		expect(rows.map(row => [row.querySelector("th")?.textContent, row.querySelector("td")?.textContent])).toEqual([
			["Target requests/s", "16"], ["Minimum requests/s", "8.5"], ["Target", "20"],
		]);
		for (const row of rows) {
			expect(row.querySelector("th")?.getAttribute("scope")).toBe("row");
			expect(row.closest('[aria-hidden="true"], [role="img"]')).toBeNull();
		}
		expect(disclosure.querySelectorAll("tbody tr")).toHaveLength(2);
	});
});
