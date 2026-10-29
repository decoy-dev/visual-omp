import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { display, isRecord } from "./util";
import "./structured.css";

export const FIELD_PAGE_SIZE = 50;

/** Only the root opens automatically; each branch mounts one bounded page until the reader reveals more. */
export function FieldTree({ value, label, depth = 0 }: { value: unknown; label?: string; depth?: number }): ReactNode {
	const { t } = useTranslation("tools");
	const [open, setOpen] = useState(depth === 0);
	const [visible, setVisible] = useState(FIELD_PAGE_SIZE);
	const container = Array.isArray(value) || isRecord(value);
	if (!container) {
		return <div className="tv-field"><span className="tv-field-key">{label !== undefined ? `${label}: ` : ""}</span><span className={`tv-field-value tv-field-value--${typeof value}`}>{typeof value === "string" ? JSON.stringify(value) : display(value) || "null"}</span></div>;
	}
	const keys = Object.keys(value);
	const size = Array.isArray(value) ? `[${keys.length}]` : `{${keys.length}}`;
	return (
		<details className="tv-field-branch" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
			<summary><span className="tv-field-key">{label !== undefined ? `${label}: ` : ""}</span><span className="tv-muted">{size}</span></summary>
			{open && <div className="tv-field-children">
				{keys.slice(0, visible).map(key => <FieldTree key={key} label={key} value={(value as Record<string, unknown>)[key]} depth={depth + 1} />)}
				{visible < keys.length && <button type="button" className="tv-expand" onClick={() => setVisible(count => count + FIELD_PAGE_SIZE)}>{t("structured.moreEntries", { count: Math.min(FIELD_PAGE_SIZE, keys.length - visible) })}</button>}
			</div>}
		</details>
	);
}

export const TABLE_ROW_PAGE_SIZE = 20;
export const TABLE_COLUMN_PAGE_SIZE = 12;

export function DataTable({ columns, rows }: { columns: Array<{ head: string; numeric: boolean }>; rows: string[][] }): ReactNode {
	const { t } = useTranslation("tools");
	const [visibleRows, setVisibleRows] = useState(TABLE_ROW_PAGE_SIZE);
	const [visibleColumns, setVisibleColumns] = useState(TABLE_COLUMN_PAGE_SIZE);
	const shownColumns = columns.slice(0, visibleColumns);
	return <div>
		<div className="tv-data-table" tabIndex={0} role="region" aria-label={t("structured.table")}>
			<table>
				<thead><tr>{shownColumns.map((column, index) => <th scope="col" key={index} className={column.numeric ? "tv-numeric" : undefined}>{column.head}</th>)}</tr></thead>
				<tbody>{rows.slice(0, visibleRows).map((row, index) => <tr key={index}>{row.slice(0, visibleColumns).map((text, column) => <td key={column} className={columns[column].numeric ? "tv-numeric" : undefined}>{text}</td>)}</tr>)}</tbody>
			</table>
		</div>
		<div className="tv-table-actions">
			{visibleRows < rows.length && <button type="button" className="tv-expand" onClick={() => setVisibleRows(count => count + TABLE_ROW_PAGE_SIZE)}>{t("structured.moreRows", { count: Math.min(TABLE_ROW_PAGE_SIZE, rows.length - visibleRows) })}</button>}
			{visibleColumns < columns.length && <button type="button" className="tv-expand" onClick={() => setVisibleColumns(count => count + TABLE_COLUMN_PAGE_SIZE)}>{t("structured.moreColumns", { count: Math.min(TABLE_COLUMN_PAGE_SIZE, columns.length - visibleColumns) })}</button>}
		</div>
	</div>;
}
