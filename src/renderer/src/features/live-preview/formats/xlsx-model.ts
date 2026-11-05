import { read, utils, type WorkBook } from "xlsx";
import { inflateOffice } from "@shared/preview-office-inflate";

export interface OfficeSheet { name: string; rows: number; cols: number; limited: boolean }
export interface OfficeWindow { sheet: number; rowStart: number; rowEnd: number; colStart: number; colEnd: number }
export interface OfficeCells extends OfficeWindow { cells: string[][] }

/** The workbook never crosses the worker boundary. Formula evaluation and HTML conversion are unused. */
export class WorkbookPreview {
	private workbook: WorkBook;
	readonly sheets: OfficeSheet[];
	constructor(bytes: Uint8Array) {
		inflateOffice(bytes, { retain: false });
		this.workbook = read(bytes, { type: "array", cellFormula: false, cellHTML: false, sheetRows: 100_000, dense: true, bookVBA: false, cellStyles: false, WTF: false });
		this.sheets = this.workbook.SheetNames.map(name => {
			const sheet = this.workbook.Sheets[name]!;
			const range = utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1");
			return { name: name.slice(0, 1000), rows: Math.min(100_000, range.e.r + 1), cols: Math.min(200, range.e.c + 1), limited: range.e.r >= 100_000 || range.e.c >= 200 };
		});
	}
	window(request: OfficeWindow): OfficeCells {
		const { sheet, rowStart, rowEnd, colStart, colEnd } = request;
		if (![sheet, rowStart, rowEnd, colStart, colEnd].every(Number.isSafeInteger)) throw new Error("unsafe");
		const meta = this.sheets[sheet];
		if (!meta || rowStart < 0 || colStart < 0 || rowEnd < rowStart || colEnd < colStart || rowEnd > meta.rows || colEnd > meta.cols
			|| rowEnd - rowStart > 100 || colEnd - colStart > 30) throw new Error("unsafe");
		const data = this.workbook.Sheets[this.workbook.SheetNames[sheet]!]!;
		const cells: string[][] = [];
		if (rowEnd > rowStart && colEnd > colStart) {
			const values = utils.sheet_to_json<unknown[]>(data, { header: 1, raw: false, defval: "", blankrows: true,
				range: { s: { r: rowStart, c: colStart }, e: { r: rowEnd - 1, c: colEnd - 1 } } });
			for (let row = 0; row < rowEnd - rowStart; row++) cells.push(Array.from({ length: colEnd - colStart }, (_, col) => String(values[row]?.[col] ?? "").slice(0, 1000)));
		}
		return { sheet, rowStart, rowEnd, colStart, colEnd, cells };
	}
}
