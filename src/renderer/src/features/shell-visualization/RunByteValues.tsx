import { useMemo, useState } from "react";
import { useDeferredTranslation } from "../../i18n";
import { Button } from "../../ui/Button";

const VALUE_BYTES = 4096;
const PAGE_VALUES = 25;
const INSPECTION_FIELDS = 50_000;
const INSPECTION_BYTES = 1024 * 1024;
const inspectionLimit = Symbol("byte inspection limit");
interface InspectionBudget { fields: number; bytes: number }
function inspect(budget: InspectionBudget, bytes = 0) {
	if (--budget.fields < 0 || (budget.bytes -= bytes) < 0) throw inspectionLimit;
}
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return !!value && typeof value === "object" && !Array.isArray(value); }
function hex(byte: number) { return `\\x${byte.toString(16).padStart(2, "0")}`; }
function escapedText(value: string) {
	return value.replace(/[\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, char => char === "\\" ? "\\\\" : char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : char.charCodeAt(0) <= 255 ? hex(char.charCodeAt(0)) : `\\u${char.charCodeAt(0).toString(16)}`);
}
export interface FormattedTraceBytes { text: string; length?: number; shown: number; escaped: boolean; limited: boolean }
/** Byte formatting only. Source offsets, shell syntax and execution state remain omp-owned. */
export function formatTraceBytes(value: unknown): FormattedTraceBytes | null {
	if (typeof value === "string") {
		const bytes = new Uint8Array(VALUE_BYTES);
		const { read, written } = new TextEncoder().encodeInto(value.slice(0, VALUE_BYTES), bytes);
		return { text: escapedText(decoder.decode(bytes.subarray(0, written))), length: read === value.length ? written : undefined, shown: written, escaped: false, limited: read < value.length };
	}
	if (!Array.isArray(value)) return null;
	const bytes: number[] = [];
	for (let index = 0; index < Math.min(value.length, VALUE_BYTES); index++) {
		const byte: unknown = value[index];
		if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return null;
		bytes.push(byte);
	}
	const metadata = { length: value.length, shown: bytes.length, limited: bytes.length < value.length };
	try { return { text: escapedText(decoder.decode(Uint8Array.from(bytes))), ...metadata, escaped: false }; }
	catch { return { text: bytes.map(byte => byte >= 32 && byte <= 126 ? byte === 92 ? "\\\\" : String.fromCharCode(byte) : hex(byte)).join(""), ...metadata, escaped: true }; }
}
interface ByteValue { path: string; value: unknown[] }
function* scalar(value: unknown, path: string, budget: InspectionBudget): Generator<ByteValue> {
	inspect(budget);
	if (Array.isArray(value)) yield { path, value };
}
function* pairs(value: unknown, path: string, budget: InspectionBudget): Generator<ByteValue> {
	if (Array.isArray(value)) for (const [index, pair] of value.entries()) {
		inspect(budget);
		if (!Array.isArray(pair)) continue;
		yield* scalar(pair[0], `${path}[${index}][0]`, budget);
		yield* scalar(pair[1], `${path}[${index}][1]`, budget);
	}
}
function* command(value: RecordValue, path: string, budget: InspectionBudget): Generator<ByteValue> {
	if (Array.isArray(value.argv)) for (const [index, arg] of value.argv.entries()) yield* scalar(arg, `${path}.argv[${index}]`, budget);
	yield* pairs(value.env, `${path}.env`, budget);
	yield* pairs(value.assigns, `${path}.assigns`, budget);
	if (Array.isArray(value.redirs)) for (const [index, redir] of value.redirs.entries()) {
		inspect(budget);
		if (record(redir)) yield* scalar(redir.target, `${path}.redirs[${index}].target`, budget);
	}
}
/** Visit only declared run-value fields, charging every container and scalar inspected. */
function* byteValues(trace: RecordValue, budget: InspectionBudget): Generator<ByteValue> {
	if (Array.isArray(trace.units)) for (const [index, unit] of trace.units.entries()) {
		inspect(budget);
		if (!record(unit)) continue;
		const path = `units[${index}]`;
		yield* scalar(unit.source, `${path}.source`, budget);
		if (Array.isArray(unit.nodes)) for (const [nodeIndex, node] of unit.nodes.entries()) {
			inspect(budget);
			if (record(node)) yield* command(node, `${path}.nodes[${nodeIndex}]`, budget);
		}
	}
	if (Array.isArray(trace.history)) for (const [index, event] of trace.history.entries()) {
		inspect(budget);
		if (!record(event)) continue;
		const path = `history[${index}]`;
		yield* command(event, path, budget);
		yield* scalar(event.name, `${path}.name`, budget);
		yield* scalar(event.value, `${path}.value`, budget);
		if (event.kind === "Diag") yield* scalar(event.text, `${path}.text`, budget);
	}
	if (Array.isArray(trace.diags)) for (const [index, diag] of trace.diags.entries()) {
		inspect(budget);
		if (record(diag)) yield* scalar(diag.message, `diags[${index}].message`, budget);
	}
}

/** Exact byte values supplement, rather than rewrite, omp's potentially lossy display text. */
export function RunByteValues({ trace }: { trace: unknown }) {
	const { t } = useDeferredTranslation("shellVisualization");
	const [open, setOpen] = useState(false);
	const [page, setPage] = useState(0);
	const found = useMemo(() => {
		const entries: { path: string; formatted: FormattedTraceBytes }[] = [];
		if (!open || !record(trace)) return { entries, more: false, limited: false };
		const budget = { fields: INSPECTION_FIELDS, bytes: INSPECTION_BYTES };
		let index = 0;
		try {
			for (const value of byteValues(trace, budget)) {
				inspect(budget, Math.min(value.value.length, VALUE_BYTES));
				const formatted = formatTraceBytes(value.value);
				if (!formatted || index++ < page * PAGE_VALUES) continue;
				if (entries.length === PAGE_VALUES) return { entries, more: true, limited: false };
				entries.push({ path: value.path, formatted });
			}
		} catch (error) {
			if (error !== inspectionLimit) throw error;
			return { entries, more: false, limited: true };
		}
		return { entries, more: false, limited: false };
	}, [trace, open, page]);
	if (!record(trace)) return null;
	return <details className="shell-details" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{t("runBytes.title")}</summary>{open && <div className="shell-detail-content">
		<p className="shell-meta">{t("runBytes.explanation")}</p>
		<dl>{found.entries.map(({ path, formatted }) => <div key={path}><dt><bdi>{path}</bdi> ({t(formatted.escaped ? "runBytes.escaped" : "runBytes.utf8")})</dt><dd dir="auto">{formatted.text || '""'}{formatted.limited && <p className="shell-meta">{t("runBytes.limited", { shown: formatted.shown, length: formatted.length })}</p>}</dd></div>)}</dl>
		{found.limited && <p role="status" className="shell-meta">{t("runBytes.inspectionLimit")}</p>}
		{!found.limited && found.entries.length === 0 && <p className="shell-meta">{t("runBytes.empty")}</p>}
		{(page > 0 || found.more) && <div className="shell-replay-buttons"><Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>{t("runBytes.previous")}</Button><Button size="sm" variant="ghost" disabled={!found.more} onClick={() => setPage(value => value + 1)}>{t("runBytes.next")}</Button></div>}
	</div>}</details>;
}
