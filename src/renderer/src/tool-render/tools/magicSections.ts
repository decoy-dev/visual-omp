/**
 * Sections of an `edit.mode: magic` payload (omp 19.1+): one file each, its changes described in Markdown.
 * Mirrors upstream `packages/tui/src/tools/magic-sections.ts`.
 */

/** One file's run of described changes, in payload order; runs naming the same path stay apart. */
export interface MagicRun {
	path: string;
	text: string;
}

const PATH_HEADER = /^# +(\S.*?)\s*$/;
const FENCE = /^\s*```/;

/** `(path, text)` runs of a payload in order; `outside` is whatever precedes the first `# path` line. */
export function splitMagicSections(input: string): { runs: MagicRun[]; outside: string } {
	const runs: MagicRun[] = [];
	let outside = "";
	let current: MagicRun | undefined;
	// A `# ` line inside a code fence is code, not the next file.
	let fenced = false;
	for (const line of input.replace(/\r\n/g, "\n").split("\n")) {
		const header = fenced ? null : PATH_HEADER.exec(line);
		if (header) {
			current = { path: header[1], text: "" };
			runs.push(current);
			continue;
		}
		if (FENCE.test(line)) fenced = !fenced;
		if (current) current.text += `${line}\n`;
		else outside += line;
	}
	return { runs, outside };
}

/** Merge runs naming the same path, matching upstream `packages/tui/src/tools/edit.ts`. */
export function mergeMagicSections(runs: readonly MagicRun[]): MagicRun[] {
	const merged: MagicRun[] = [];
	const byPath = new Map<string, MagicRun>();
	for (const run of runs) {
		const trimmed = run.text.trim();
		const existing = byPath.get(run.path);
		if (existing) {
			if (trimmed) existing.text = existing.text ? `${existing.text}\n\n${trimmed}` : trimmed;
			continue;
		}
		const entry: MagicRun = { path: run.path, text: trimmed };
		byPath.set(run.path, entry);
		merged.push(entry);
	}
	return merged;
}

const NON_MAGIC_HEADER = /^(?:\[.+?(?:#[0-9a-fA-F]{4})?\]|\*{3} (?:Update|Add|Delete) File:\s*.+)$/;

/** True when `input` uses omp 19.1's `magic` edit format (`# <path>` headers, not hashline or apply_patch). */
export function isMagicInput(input: string): boolean {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	for (const raw of stripped.replace(/\r\n/g, "\n").split("\n")) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		if (NON_MAGIC_HEADER.test(trimmed)) return false;
		if (PATH_HEADER.test(raw)) return true;
	}
	return false;
}
