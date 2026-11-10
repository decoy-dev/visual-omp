import type { TspProps } from "@shared/tsp";
import { KeyCombinations } from "../../../ui/KeyCombinations";
import "../../../chat/transcript/transcript.css";
import { plain } from "../../../state/tsp/labels";

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
