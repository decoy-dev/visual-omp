import { Markdown } from "../../../transcript/Markdown";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { SizeNote, useContentHeight, useSourceText, WaitingForSave } from "./shared";

/** RFC 4180 quoting also applies to TSV. A streaming record is complete only after its newline. */
export function csvMarkdown(source: string, delimiter: "," | "\t", writing: boolean): string {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let at = 0; at < source.length; at++) {
		const char = source[at];
		if (char === '"') {
			if (quoted && source[at + 1] === '"') { field += '"'; at++; }
			else if (quoted || field === "") quoted = !quoted;
			else field += char;
		} else if (!quoted && char === delimiter) { row.push(field); field = ""; }
		else if (!quoted && (char === "\n" || char === "\r")) {
			row.push(field); rows.push(row); row = []; field = "";
			if (char === "\r" && source[at + 1] === "\n") at++;
		} else field += char;
	}
	if (!writing && !quoted && (field || row.length)) { row.push(field); rows.push(row); }
	if (!rows.length) return "";
	const columns = rows[0].length;
	const line = (cells: string[]) => `| ${Array.from({ length: columns }, (_, index) => (cells[index] ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")).join(" | ")} |`;
	return [line(rows[0]), `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

export function Frame({ subject, onHeight }: LiveFrameProps) {
	const { text, error } = useSourceText(subject);
	const content = useContentHeight(onHeight);
	return <div className="min-h-0 flex-1 overflow-auto p-4"><div ref={content} className="flow-root">{subject.elided ? <SizeNote /> : <><Markdown text={csvMarkdown(text ?? "", /\.tsv$/i.test(subject.path ?? "") ? "\t" : ",", subject.state === "writing")} />{error && <WaitingForSave />}</>}</div></div>;
}

export const adapter: LiveAdapter = { format: "csv", maxFps: 4, Frame };
