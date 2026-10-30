import type { CSSProperties } from "react";
export interface AnsiRun { text: string; style: CSSProperties }
const colours = ["var(--fg)", "var(--err)", "var(--ok)", "var(--warn)", "var(--term-blue)", "var(--term-magenta)", "var(--accent)", "var(--fg)"];
/** SGR-only: never turn OSC hyperlinks or other terminal controls into DOM instructions. */
export function ansiRuns(text: string, palette?: readonly string[]): AnsiRun[] {
	const result: AnsiRun[] = [];
	let style: CSSProperties = {};
	const clean = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[(?![\d;]*m)[\d;?]*[ -/]*[@-~]/g, "");
	let cursor = 0;
	for (const match of clean.matchAll(/\x1b\[([\d;]*)m/g)) {
		if (match.index > cursor) result.push({ text: clean.slice(cursor, match.index), style: { ...style } });
		for (const code of (match[1] || "0").split(";").map(Number)) {
			if (code === 0) style = {};
			else if (code === 1) style.fontWeight = 600;
			else if (code === 3) style.fontStyle = "italic";
			else if (code === 4) style.textDecoration = "underline";
			else if (code === 22) delete style.fontWeight;
			else if (code === 23) delete style.fontStyle;
			else if (code >= 30 && code <= 37) style.color = palette?.[code - 30] ?? colours[code - 30];
			else if (code >= 90 && code <= 97) style.color = palette?.[code - 90 + 8] ?? colours[code - 90];
			else if (code === 24) delete style.textDecoration;
			else if (code === 39) delete style.color;
		}
		cursor = match.index + match[0].length;
	}
	if (cursor < clean.length) result.push({ text: clean.slice(cursor), style });
	return result;
}
