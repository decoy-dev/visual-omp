import { stripAnsi } from "../util";

export interface DiagnosticRow {
	file: string;
	line: string;
	col: string;
	severity: string;
	message: string;
}

export interface LocationRow {
	file: string;
	line: string;
	col: string;
	context: { line: string; text: string }[];
}

export interface LocationResult {
	rows: LocationRow[];
	other: string;
	count: number;
	noun: string;
}

export interface DiagnosticResult {
	rows: DiagnosticRow[];
	failures: string[];
	warnings: string[];
	unverified: string[];
	files: number;
	other: string;
}

const DIAGNOSTIC_RE = /^(.*):(\d+):(\d+)\s+\[(error|warning|info|hint)\]\s*(.*)$/i;
const LOCATION_HEADER_RE = /^Found (\d+) (definition|type definition|implementation|reference)\(s\):$/;
const LOCATION_RE = /^ {2}(.+):(\d+):(\d+)$/;
const CONTEXT_RE = /^ {4}(\d+): ?(.*)$/;
const STATUS_GLYPH_RE = /^(?:\[[^\]\s]*\]|[^\p{L}\p{N}\s./~\\]+)\s+/u;
const SUMMARY_RE = /^\d+ \w+\(s\)(?:, \d+ \w+\(s\))*:?$/;

/** Locations win before diagnostics: source context can itself contain diagnostics or fences. */
export function parseLocationResult(text: string, action: string | null): LocationResult | null {
	const lines = stripAnsi(text).split("\n");
	const header = LOCATION_HEADER_RE.exec(lines[0] ?? "");
	const knownAction = action !== null && ["definition", "type_definition", "implementation", "references"].includes(action);
	if (!header && !knownAction) return null;
	const rows: LocationRow[] = [];
	const other: string[] = [];
	for (const raw of header ? lines.slice(1) : lines) {
		const current = rows.at(-1);
		const context = current ? CONTEXT_RE.exec(raw) : null;
		if (current && context) {
			current.context.push({ line: context[1], text: context[2] });
			continue;
		}
		// Older results can contain unindented location rows.
		const match = LOCATION_RE.exec(raw) ?? (!header ? /^(.+):(\d+):(\d+)$/.exec(raw) : null);
		if (match) rows.push({ file: match[1], line: match[2], col: match[3], context: [] });
		else if (raw.trim()) other.push(raw);
	}
	if (rows.length === 0) return null;
	return {
		rows,
		other: other.join("\n"),
		count: header ? Number(header[1]) : rows.length,
		noun: header?.[2] ?? (action === "references" ? "reference" : action?.replace(/_/g, " ") ?? "location"),
	};
}

/** omp details identify the action; diagnostics themselves are formatted text in 18.15-18.17. */
export function parseDiagnosticResult(text: string, action: string | null): DiagnosticResult | null {
	if (action !== null && action !== "diagnostics") return null;
	const rows: DiagnosticRow[] = [];
	const failures: string[] = [];
	const warnings: string[] = [];
	const unverified: string[] = [];
	const other: { text: string; grouped?: boolean }[] = [];
	const summaries: string[] = [];
	const files = new Set<string>();
	const directories: { depth: number; path: string; output: { text: string; grouped?: boolean } }[] = [];
	let file: { path: string; output: { text: string; grouped?: boolean } } | null = null;
	let recognized = false;
	for (const raw of stripAnsi(text).split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const header = /^(#+)\s+(.*)$/.exec(raw);
		if (header) {
			const depth = header[1].length;
			while (directories.length && directories[directories.length - 1].depth >= depth) directories.pop();
			const name = header[2];
			const path = `${directories.at(-1)?.path ?? ""}${name}`;
			const output = { text: raw, grouped: false };
			other.push(output);
			if (name.endsWith("/")) {
				directories.push({ depth, path, output });
				file = null;
			} else file = { path, output };
			continue;
		}
		const status = line.replace(STATUS_GLYPH_RE, "");
		const statusFile = /^(.*): (?:all language servers failed|some servers failed|no diagnostics report yet|No language server found|no issues|\d+ \w+\(s\))/.exec(status);
		if (statusFile) files.add(statusFile[1]);
		if (/\ball language servers failed\b|: No language server found\b/.test(status)) {
			failures.push(status);
			recognized = true;
		} else if (/\bsome servers failed\b/.test(status)) {
			warnings.push(status);
			recognized = true;
		} else if (/\bno diagnostics report yet\b/.test(status)) {
			unverified.push(status);
			recognized = true;
		} else if (SUMMARY_RE.test(line) || /: \d+ \w+\(s\)(?:, \d+ \w+\(s\))*$/.test(status)) {
			summaries.push(raw);
			recognized = true;
		} else if (line === "OK" || /: no issues$/.test(status)) {
			recognized = true;
		} else {
			const relative = file && /^\d+:\d+\s+\[/.test(line);
			const match = DIAGNOSTIC_RE.exec(relative ? `${file!.path}:${line}` : line);
			if (match) {
				if (relative && file) {
					file.output.grouped = true;
					for (const directory of directories) directory.output.grouped = true;
				}
				rows.push({ file: match[1], line: match[2], col: match[3], severity: match[4].toLowerCase(), message: match[5] });
				files.add(match[1]);
				recognized = true;
			} else other.push({ text: raw });
		}
	}
	const retained = other.filter(line => !line.grouped).map(line => line.text);
	return recognized ? { rows, failures, warnings, unverified, files: files.size, other: (rows.length === 0 ? summaries.concat(retained) : retained).join("\n") } : null;
}
