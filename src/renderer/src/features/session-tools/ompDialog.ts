/**
 * Reader for omp's generic in-place dialogs: the selector, confirm, one-line input and multi-line
 * editor that builtin commands open in the editor slot (`/seance`, `/cleanse`, `/fork` confirms, the
 * goal prompts…). omp keeps these local to its TUI, so the app reads them from the painted screen
 * (`host:screen` plain text) and answers with keys. Formats come from omp 18.11-18.12
 * (`packages/tui/src/overlays/hook-selector.ts`, `hook-input.ts`, `hook-editor.ts`,
 * `chrome/overlay-box.ts`, and `showHookConfirm` in `extension-ui-controller.ts`) with the unicode
 * symbol preset the chat's config overlay pins:
 *
 * ```
 * ╭─ Title ──────────────╮   OverlayPanel: title inset into the top rule
 * │                      │   spacer
 * │ detail line          │   further title lines (a confirm's message)
 * │                      │   spacer
 * │  ❯ Option            │   option rows: Text padded by one column, `❯ ` on the cursor row
 * │      description     │   description rows, indented four columns past the label
 * │    (1/20)  Type to search │ status row when the list is windowed or filtered
 * │                      │   spacer
 * │ ↑/↓ navigate  ⏎ select  ⎋ cancel │ help text (or the caller's own)
 * │                      │   spacer
 * ╰──────────────────────╯
 * ```
 *
 * Text dialogs share the frame: `> value` for the input and the prompt-style editor, a nested
 * editor box for the hook-style editor, then a key legend ending in "submit … cancel".
 *
 * The parser answers null whenever a screen does not fit these shapes, so the terminal sheet stays
 * the fallback for anything it does not recognise.
 */

export interface OmpDialogOption {
	label: string;
	description: string | null;
}

interface DialogBase {
	/** First title line, as inset into the top rule (a countdown suffix removed). */
	title: string;
	/** Further title lines (a confirm's message), with blank lines kept as "". */
	detail: string[];
	/** tmux-style key that cancels the dialog. */
	cancelKey: string;
}

export interface OmpSelectDialog extends DialogBase {
	kind: "select";
	/** Options painted on screen, in order (a windowed list shows only part of the options). */
	options: OmpDialogOption[];
	/** Index into `options` of omp's highlighted row. */
	selected: number;
	/** The caller's own help text; null when omp shows its default key legend. */
	help: string | null;
	/** Options omp has but does not paint (windowed or filtered list). */
	hidden: number;
	/** Type-to-search query omp is filtering by, if any. */
	query: string | null;
	/** omp's yes/no confirm (`showHookConfirm`). */
	confirm: boolean;
}

export interface OmpTextDialog extends DialogBase {
	/** `input`: one line (HookInput). `editor`: multi-line (HookEditor). */
	kind: "input" | "editor";
	/** Text currently in the field, as painted (a long value may be cut or scrolled). */
	value: string;
	/** tmux-style key that submits the text. */
	submitKey: string;
}

export type OmpDialog = OmpSelectDialog | OmpTextDialog;

const TOP = /^\s*╭─ (.+?) ─*╮\s*$/;
const BOTTOM = /^\s*╰─+╯\s*$/;
const FRAMED = /^\s*│(.*)│\s*$/;
const CURSOR = "❯";
const RADIO_ON = "◉";
const RADIO_OFF = "○";
const CHECKBOX = /^[☑☐] /;
const STATUS = /^\((\d+)\/(\d+)(?: of (\d+))?\)\s+(?:Type to search|Search: (.*))$/;
const DEFAULT_SELECT_HELP = /navigate\b.*\bselect\b.*\bcancel\b/;
const TEXT_LEGEND = /\bsubmit\b.*\bcancel\b/;

/** The bottom-most framed box, as body rows (frame and one-column insets removed). */
function lastBox(lines: readonly string[]): { title: string; rows: string[] } | null {
	const bottom = lines.findLastIndex(line => BOTTOM.test(line));
	if (bottom < 0) return null;
	// The dialog takes the editor's place, so nothing framed is painted below it.
	if (lines.slice(bottom + 1).some(line => /^\s*[╭│╰]/.test(line))) return null;
	const rows: string[] = [];
	for (let index = bottom - 1; index >= 0; index--) {
		const line = lines[index] ?? "";
		const top = TOP.exec(line);
		if (top?.[1]) return { title: top[1].replace(/\s+\(\d+s\)$/, "").trim(), rows: rows.reverse() };
		const framed = FRAMED.exec(line);
		if (!framed) return null;
		// `│ content │`: one column of inset on each side.
		rows.push((framed[1] ?? "").replace(/^ /, "").replace(/ $/, "").trimEnd());
	}
	return null;
}

/** Split body rows at blank rows into runs of non-blank rows, each with the index of its first row. */
function blocks(rows: readonly string[]): { start: number; rows: string[] }[] {
	const out: { start: number; rows: string[] }[] = [];
	let current: string[] | null = null;
	for (const [index, row] of rows.entries()) {
		if (row.trim() === "") {
			current = null;
			continue;
		}
		if (!current) {
			current = [];
			out.push({ start: index, rows: current });
		}
		current.push(row);
	}
	return out;
}

/**
 * The key a legend names before `action` ("⏎ or ⌃Q submit", "⌃Q/⌃⏎ submit", "Ctrl+Q submit"), as a
 * tmux-style token for omp's debug input; the first alternative that maps wins.
 */
export function legendKey(legend: string, action: string, fallback: string): string {
	const match = new RegExp(`(\\S+(?: or \\S+)*)\\s+${action}\\b`).exec(legend);
	if (!match?.[1]) return fallback;
	for (const alternative of match[1].split(/\/| or /)) {
		const token = keyToken(alternative.trim());
		if (token) return token;
	}
	return fallback;
}

const NAMED_KEYS: Record<string, string> = { "⏎": "enter", "⎋": "escape", "⇥": "tab", enter: "enter", esc: "escape", tab: "tab" };

function keyToken(label: string): string | null {
	let rest = label;
	let prefix = "";
	for (;;) {
		const modifier = /^(⌃|Ctrl\+)/i.exec(rest) ? "C-" : /^(⌥|Alt\+)/i.exec(rest) ? "M-" : /^(⇧|Shift\+)/i.exec(rest) ? "S-" : null;
		if (!modifier) break;
		prefix += modifier;
		rest = rest.replace(/^(⌃|⌥|⇧|Ctrl\+|Alt\+|Shift\+)/i, "");
	}
	const named = NAMED_KEYS[rest.toLowerCase()];
	if (named) return prefix + named;
	if (/^[A-Za-z0-9]$/.test(rest)) return prefix + rest.toLowerCase();
	return null;
}

/** The selector's option rows (outline frame removed), or null when they do not read as one. */
function readOptions(block: readonly string[]): { options: OmpDialogOption[]; selected: number; hidden: number; query: string | null } | null {
	let rows = [...block];
	// `outline: true` wraps the list in its own rules and bars, without the row padding.
	const outline = rows.length > 2 && /^─+$/.test(rows[0] ?? "") && /^─+$/.test(rows.at(-1) ?? "");
	rows = outline ? rows.slice(1, -1).map(row => row.replace(/^│/, "").replace(/│$/, "")) : rows.map(row => row.replace(/^ /, ""));
	const options: OmpDialogOption[] = [];
	let selected = -1;
	let total: number | null = null;
	let query: string | null = null;
	let last: "label" | "description" | null = null;
	for (const raw of rows) {
		const row = raw.trimEnd();
		const status = STATUS.exec(row.trim());
		if (status && /^\s/.test(row)) {
			total = Number(status[3] ?? status[2]);
			query = status[4]?.trim() || null;
			last = null;
			continue;
		}
		if (row.trim() === "No matching options") return null;
		if (CHECKBOX.test(row)) return null; // Multi-select rows show no cursor in plain text.
		const head = row.slice(0, 2);
		if (head === `${CURSOR} ` || head === `${RADIO_ON} ` || head === `${RADIO_OFF} `) {
			if (head !== `${RADIO_OFF} `) {
				if (selected >= 0) return null;
				selected = options.length;
			}
			options.push({ label: row.slice(2).trim(), description: null });
			last = "label";
			continue;
		}
		if (/^ {4}\S/.test(row) && options.length > 0) {
			const option = options[options.length - 1];
			if (!option) return null;
			option.description = option.description ? `${option.description} ${row.trim()}` : row.trim();
			last = "description";
			continue;
		}
		if (/^ {2}\S/.test(row)) {
			options.push({ label: row.trim(), description: null });
			last = "label";
			continue;
		}
		// A long label or description wraps to column zero.
		if (/^\S/.test(row) && last) {
			const option = options[options.length - 1];
			if (!option) return null;
			if (last === "label") option.label = `${option.label} ${row.trim()}`;
			else option.description = `${option.description ?? ""} ${row.trim()}`.trim();
			continue;
		}
		return null;
	}
	if (options.length === 0 || selected < 0) return null;
	return { options, selected, hidden: total === null ? 0 : Math.max(0, total - options.length), query };
}

function trimBlank(rows: readonly string[]): string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && rows[start]?.trim() === "") start++;
	while (end > start && rows[end - 1]?.trim() === "") end--;
	return rows.slice(start, end);
}

function parseSelect(title: string, rows: readonly string[]): OmpSelectDialog | null {
	const runs = blocks(rows);
	const help = runs.at(-1);
	const list = runs.at(-2);
	if (!help || !list) return null;
	const read = readOptions(list.rows);
	if (!read) return null;
	// Detail: everything between the opening spacer and the list's spacer, blank lines kept.
	const detailRows = trimBlank(rows.slice(1, Math.max(1, list.start - 1)));
	// A slider (`◂ … ▸`) moves with left/right, which the card does not offer.
	if (detailRows.some(row => row.includes("◂") && row.includes("▸"))) return null;
	const helpText = help.rows.map(row => row.trim()).join(" ");
	const labels = read.options.map(option => option.label);
	return {
		kind: "select",
		title,
		detail: detailRows.map(row => row.trim()),
		options: read.options,
		selected: read.selected,
		help: DEFAULT_SELECT_HELP.test(helpText) ? null : helpText,
		hidden: read.hidden,
		query: read.query,
		confirm: read.hidden === 0 && labels.length === 2 && labels[0] === "Yes" && labels[1] === "No",
		cancelKey: legendKey(helpText, "cancel", "escape"),
	};
}

/** Lines of the hook-style editor's nested box (`│  text │` rows, the last line inside `╰─ text ─╯`). */
function boxedValue(rows: readonly string[], start: number): { value: string; end: number } | null {
	const lines: string[] = [];
	for (let index = start + 1; index < rows.length; index++) {
		const row = rows[index] ?? "";
		if (/^╰─/.test(row)) {
			lines.push(row.slice(3).replace(/[\s─]*╯$/, ""));
			return { value: lines.map(line => line.replace(/[\s│█▐]+$/, "")).join("\n").trim(), end: index };
		}
		if (!row.startsWith("│")) return null;
		lines.push(row.slice(3).replace(/\s*│$/, ""));
	}
	return null;
}

function parseText(title: string, rows: readonly string[]): OmpTextDialog | null {
	const body = trimBlank(rows);
	const legendIndex = body.length - 1;
	const legend = body[legendIndex]?.trim() ?? "";
	if (!TEXT_LEGEND.test(legend)) return null;
	const editor = /\bexternal editor\b/.test(legend);
	const boxStart = body.findIndex(row => /^╭─+╮$/.test(row));
	const promptStart = body.findIndex(row => row.startsWith("> ") || row === ">");
	let value: string;
	let fieldStart: number;
	if (editor && boxStart >= 0) {
		const boxed = boxedValue(body, boxStart);
		if (!boxed) return null;
		value = boxed.value;
		fieldStart = boxStart;
	} else if (promptStart >= 0) {
		const lines = [body[promptStart]?.slice(2) ?? ""];
		for (let index = promptStart + 1; index < legendIndex; index++) {
			const row = body[index] ?? "";
			if (!row.startsWith("  ")) break;
			lines.push(row.slice(2));
		}
		value = lines.map(line => line.trimEnd()).join("\n").trim();
		fieldStart = promptStart;
	} else {
		return null;
	}
	const kind = editor ? "editor" : "input";
	const promptStyle = kind === "editor" && boxStart < 0;
	return {
		kind,
		title,
		detail: trimBlank(body.slice(0, fieldStart)).map(row => row.trim()),
		value,
		// Prompt-style editors and inputs submit on Enter; the hook-style editor on the follow-up chord.
		submitKey: legendKey(legend, "submit", kind === "input" || promptStyle ? "enter" : "C-q"),
		cancelKey: legendKey(legend, "cancel", "escape"),
	};
}

/** omp's in-place dialog on this screen, or null when there is none (or it is not one we read). */
export function parseOmpDialog(lines: readonly string[]): OmpDialog | null {
	const box = lastBox(lines);
	// Every one of these dialogs opens and closes with a spacer row inside its frame.
	if (!box || box.rows.length < 3 || box.rows[0]?.trim() !== "" || box.rows.at(-1)?.trim() !== "") return null;
	return parseSelect(box.title, box.rows) ?? parseText(box.title, box.rows);
}

/**
 * Identity of a dialog: a new title, message or option list is a new question. A windowed list
 * paints other labels as its highlight scrolls, so only its option count takes part.
 */
export function dialogKey(dialog: OmpDialog): string {
	const head = `${dialog.kind}:${dialog.title}:${dialog.detail.join("\n")}`;
	if (dialog.kind !== "select") return head;
	return dialog.hidden > 0 ? `${head}:${dialog.options.length + dialog.hidden}` : `${head}:${dialog.options.map(option => option.label).join("\u0000")}`;
}
