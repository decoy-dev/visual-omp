import type { TspProps, TspText } from "@shared/tsp";
import { Fragment } from "react";
import { Kbd } from "../../../ui/Display";
import "../../../chat/transcript/transcript.css";
import { plain } from "../labels";
import { shortcutKeyLabel, shortcutKeyName, shortcutRuns } from "../shortcuts";

export function KeyCombinations({ value }: { value: TspText }) {
	const platform = window.vomp.platform;
	return <span className="tsp-key-combinations">{shortcutRuns(value).map((run, index) => {
		if (run.kind === "chord") return <span key={index} className="tsp-key-chord" title={run.source}>
			<span className="sr-only">{run.keys.map(key => shortcutKeyName(key, platform)).join(" + ")}</span>
			<span aria-hidden className="tsp-key-chord">{run.keys.map((key, part) => <Fragment key={part}>{part > 0 && <span className="tsp-key-join">+</span>}<Kbd>{shortcutKeyLabel(key, platform)}</Kbd></Fragment>)}</span>
		</span>;
		if (run.kind === "code") return <code key={index}>{run.text}</code>;
		if (run.kind === "separator") return <Fragment key={index}><span aria-hidden className="tsp-key-separator">{run.text}</span><span className="sr-only"> or </span></Fragment>;
		return <span key={index} className="tsp-key-note">{run.text}</span>;
	})}</span>;
}

/** The fixed two-column proportions align sibling tables without measuring text or depending on an omp role. */
export function Table({ p }: { p?: TspProps<"table"> }) {
	const columns = p?.cols ?? [];
	return <div className="tsp-table tr-md" data-columns={columns.length}><div className="tr-table"><table>
		{columns.length === 2 && <colgroup><col style={{ width: "40%" }} /><col style={{ width: "60%" }} /></colgroup>}
		<thead><tr>{columns.map(column => <th key={column.id} scope="col" align={column.align === "end" ? "right" : column.align === "center" ? "center" : "left"}>{plain(column.head)}</th>)}</tr></thead>
		<tbody>{p?.rows.map(row => <tr key={row.id}>{columns.map(column => {
			const value = row.cells[column.id] ?? "";
			// Only explicit key spans identify keyboard data; column ids are arbitrary program-owned names.
			const keys = typeof value !== "string" && value.some(span => span.s?.split(" ").includes("key"));
			return <td key={column.id} align={column.align === "end" ? "right" : column.align === "center" ? "center" : "left"}>{keys ? <KeyCombinations value={value} /> : plain(value)}</td>;
		})}</tr>)}</tbody>
	</table></div></div>;
}
