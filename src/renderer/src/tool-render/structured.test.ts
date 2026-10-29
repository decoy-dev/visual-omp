// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import "../i18n";
import { DataTable, FIELD_PAGE_SIZE, FieldTree, TABLE_COLUMN_PAGE_SIZE, TABLE_ROW_PAGE_SIZE } from "./structured";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
async function mount(element: ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ root, container });
	await act(async () => root.render(element));
	return container;
}
afterEach(async () => {
	for (const { root, container } of mounted.splice(0)) {
		await act(async () => root.unmount());
		container.remove();
	}
});

function button(container: HTMLElement, label: string): HTMLButtonElement {
	const found = [...container.querySelectorAll("button")].find(item => item.textContent === label);
	expect(found).toBeDefined();
	return found!;
}

describe("bounded structured output", () => {
	it("initially mounts only one page of a large flat array and reveals its later items", async () => {
		const container = await mount(createElement(FieldTree, { value: Array.from({ length: FIELD_PAGE_SIZE * 100 }, (_, index) => `item-${index}`) }));
		expect(container.querySelectorAll(".tv-field")).toHaveLength(FIELD_PAGE_SIZE);
		expect(container.querySelectorAll("*").length).toBeLessThan(200);
		expect(container.textContent).not.toContain(`item-${FIELD_PAGE_SIZE}`);
		await act(async () => button(container, `Show ${FIELD_PAGE_SIZE} more entries`).click());
		expect(container.textContent).toContain(`item-${FIELD_PAGE_SIZE}`);
		expect(container.querySelectorAll(".tv-field")).toHaveLength(FIELD_PAGE_SIZE * 2);
	});
	it("does not eagerly mount nested branch pages", async () => {
		const nested = Array.from({ length: 1000 }, () => "nested-value");
		const value = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`branch-${index}`, nested]));
		const container = await mount(createElement(FieldTree, { value }));
		expect(container.querySelectorAll("details")).toHaveLength(FIELD_PAGE_SIZE + 1);
		expect(container.querySelectorAll("*").length).toBeLessThan(300);
		expect(container.textContent).not.toContain("nested-value");
		const child = container.querySelector<HTMLDetailsElement>(".tv-field-children details")!;
		await act(async () => { child.open = true; child.dispatchEvent(new Event("toggle")); });
		expect(child.querySelectorAll(".tv-field")).toHaveLength(FIELD_PAGE_SIZE);
		expect(child.textContent).toContain("nested-value");
	});
	it("bounds both table dimensions and exposes later rows and columns", async () => {
		const columns = Array.from({ length: TABLE_COLUMN_PAGE_SIZE + 1 }, (_, index) => ({ head: `Column ${index}`, numeric: true }));
		const rows = Array.from({ length: TABLE_ROW_PAGE_SIZE + 1 }, (_, row) => columns.map((_, column) => `${row}:${column}`));
		const container = await mount(createElement(DataTable, { columns, rows }));
		expect(container.querySelectorAll("tbody tr")).toHaveLength(TABLE_ROW_PAGE_SIZE);
		expect(container.querySelectorAll("th")).toHaveLength(TABLE_COLUMN_PAGE_SIZE);
		expect(container.querySelectorAll("td")).toHaveLength(TABLE_ROW_PAGE_SIZE * TABLE_COLUMN_PAGE_SIZE);
		expect(container.querySelectorAll("*").length).toBeLessThan(300);
		expect(container.textContent).not.toContain(`${TABLE_ROW_PAGE_SIZE}:${TABLE_COLUMN_PAGE_SIZE}`);
		await act(async () => button(container, "Show 1 more row").click());
		await act(async () => button(container, "Show 1 more column").click());
		expect(container.textContent).toContain(`${TABLE_ROW_PAGE_SIZE}:${TABLE_COLUMN_PAGE_SIZE}`);
		expect(container.querySelectorAll("button")).toHaveLength(0);
	});
});
