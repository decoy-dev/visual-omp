import { describe, expect, it } from "vitest";
import { utils, write, type WorkBook } from "xlsx";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { WorkbookPreview } from "./xlsx-model";

function bytesOf(workbook: WorkBook): Uint8Array {
	return new Uint8Array(write(workbook, { type: "array", bookType: "xlsx" }));
}

describe("worker-owned workbook previews", () => {
	it("shows cached formula values and literal markup without formulas or HTML", () => {
		const workbook = utils.book_new();
		const sheet = utils.aoa_to_sheet([["<img src=x onerror=alert(1)>", 2, 6], ["x".repeat(1500)]]);
		sheet.C1 = { t: "n", f: "B1*3", v: 6 };
		utils.book_append_sheet(workbook, sheet, "Summary");
		utils.book_append_sheet(workbook, utils.aoa_to_sheet([["Second"]]), "Other sheet");
		const model = new WorkbookPreview(bytesOf(workbook));
		expect(model.sheets.map(sheet => sheet.name)).toEqual(["Summary", "Other sheet"]);
		const result = model.window({ sheet: 0, rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 3 });
		expect(result.cells[0]).toEqual(["<img src=x onerror=alert(1)>", "2", "6"]);
		expect(result.cells[1]?.[0]).toHaveLength(1000);
		expect(model.window({ sheet: 1, rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }).cells).toEqual([["Second"]]);
	});
	it("windows a 50000-row sheet instead of transferring the workbook", () => {
		const workbook = utils.book_new();
		utils.book_append_sheet(workbook, utils.aoa_to_sheet(Array.from({ length: 50_000 }, (_, index) => [index + 1, `Row ${index + 1}`])), "Large sheet");
		const model = new WorkbookPreview(bytesOf(workbook));
		expect(model.sheets[0]).toMatchObject({ rows: 50_000, cols: 2, limited: false });
		const result = model.window({ sheet: 0, rowStart: 49_960, rowEnd: 50_000, colStart: 0, colEnd: 2 });
		expect(result.cells).toHaveLength(40);
		expect(result.cells.at(-1)).toEqual(["50000", "Row 50000"]);
	});
	it("caps exposed dimensions and rejects oversized or invalid requests", () => {
		const workbook = utils.book_new(), sheet = utils.aoa_to_sheet([["one"]]);
		utils.book_append_sheet(workbook, sheet, "Bounded");
		const files = unzipSync(bytesOf(workbook));
		files["xl/worksheets/sheet1.xml"] = strToU8(strFromU8(files["xl/worksheets/sheet1.xml"]!).replace(/<dimension ref="[^"]*"/, '<dimension ref="A1:XFD1048576"'));
		const model = new WorkbookPreview(zipSync(files));
		expect(model.sheets[0]).toMatchObject({ rows: 100_000, cols: 200, limited: true });
		for (const request of [
			{ sheet: 0, rowStart: 0, rowEnd: 101, colStart: 0, colEnd: 1 },
			{ sheet: 0, rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 31 },
			{ sheet: 0, rowStart: -1, rowEnd: 1, colStart: 0, colEnd: 1 },
			{ sheet: 3, rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
		]) expect(() => model.window(request)).toThrow("unsafe");
	});
});
