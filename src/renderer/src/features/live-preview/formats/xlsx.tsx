import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import XlsxWorker from "./xlsx.worker?worker";
import { OfficeWorkerClient } from "./office-worker-client";
import { usePreviewGrant } from "./usePreviewGrant";
import { WaitingForSave } from "./shared";
import { FileName } from "../../panes/common";
import { cn } from "../../../ui";
import type { LiveAdapter, LiveFrameProps } from "../types";
import type { OfficeCells, OfficeSheet, OfficeWindow } from "./xlsx-model";

export function columnName(index: number): string {
	let text = "";
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + (n - 1) % 26) + text;
	return text;
}

export function visibleOfficeWindow(sheet: number, meta: OfficeSheet, top: number, left: number, height: number, width: number, rowHeight: number): OfficeWindow {
	const rowStart = Math.max(0, Math.floor(top / rowHeight) - 4), colStart = Math.max(0, Math.floor(left / 160) - 1);
	return { sheet, rowStart, rowEnd: Math.min(meta.rows, rowStart + Math.min(48, Math.ceil(height / rowHeight) + 8)),
		colStart, colEnd: Math.min(meta.cols, colStart + Math.min(30, Math.ceil(width / 160) + 3)) };
}

interface LoadedWorkbook { client: OfficeWorkerClient | null; sheets: OfficeSheet[]; revision: number; path: string; initial?: OfficeCells }
function Grid({ book, frozen, onPresentation }: { book: LoadedWorkbook; frozen: boolean; onPresentation(window: OfficeCells): void }) {
	const { t } = useTranslation("panes");
	const [sheet, setSheet] = useState(book.initial?.sheet ?? 0);
	const [cells, setCells] = useState<OfficeCells | null>(book.initial ?? null);
	const savePresentation = useRef(onPresentation);
	savePresentation.current = onPresentation;
	const [failed, setFailed] = useState(false);
	const viewport = useRef<HTMLDivElement>(null);
	const [view, setView] = useState({ top: 0, left: 0, height: 256, width: 320, rowHeight: 32 });
	const [active, setActive] = useState({ row: 0, col: 0 });
	const meta = book.sheets[sheet];
	useEffect(() => {
		const element = viewport.current;
		if (!element) return;
		const measure = () => setView(previous => ({ ...previous, height: element.clientHeight, width: element.clientWidth,
			rowHeight: Math.max(32, (parseFloat(getComputedStyle(element).fontSize) || 0) * 2.4) }));
		measure();
		const observer = new ResizeObserver(measure); observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const restored = book.client === null;
	const window = meta ? restored ? cells : visibleOfficeWindow(sheet, meta, view.top, view.left, view.height, view.width, view.rowHeight) : null;
	const key = window ? `${window.sheet}:${window.rowStart}:${window.rowEnd}:${window.colStart}:${window.colEnd}` : "";
	useEffect(() => {
		if (!book.client || !window || (frozen && cells !== null)) return;
		let current = true;
		void book.client.request<OfficeCells>({ window }).then(value => {
			if (current) { setCells(value); setFailed(false); savePresentation.current(value); }
		}).catch(() => { if (current) setFailed(true); });
		return () => { current = false; };
	}, [book, key, frozen]);
	const selectSheet = (next: number) => {
		setSheet(next); setCells(null); setActive({ row: 0, col: 0 });
		if (viewport.current) { viewport.current.scrollTop = 0; viewport.current.scrollLeft = 0; }
		setView(value => ({ ...value, top: 0, left: 0 }));
	};
	const shown = cells?.sheet === sheet ? cells : null;
	const rowOffset = restored ? shown?.rowStart ?? 0 : 0, colOffset = restored ? shown?.colStart ?? 0 : 0;
	return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
		<div role="tablist" aria-label={t("live.office.sheets")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-1">
			{book.sheets.map((item, index) => <button key={index} disabled={frozen} type="button" role="tab" aria-selected={sheet === index} tabIndex={sheet === index ? 0 : -1}
				title={item.name} onClick={() => selectSheet(index)} onKeyDown={event => {
					const next = event.key === "ArrowRight" ? (sheet + 1) % book.sheets.length : event.key === "ArrowLeft" ? (sheet + book.sheets.length - 1) % book.sheets.length : event.key === "Home" ? 0 : event.key === "End" ? book.sheets.length - 1 : null;
					if (next === null) return; event.preventDefault(); selectSheet(next);
					(event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
				}} className={cn("max-w-36 shrink-0 rounded-sm px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-ring", sheet === index ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover")}><FileName name={item.name} /></button>)}
		</div>
		{meta && <div ref={viewport} role="grid" aria-label={meta.name} aria-readonly="true" aria-rowcount={meta.rows + 1} aria-colcount={meta.cols + 1}
			tabIndex={0} aria-activedescendant={shown && active.row >= shown.rowStart && active.row < shown.rowEnd && active.col >= shown.colStart && active.col < shown.colEnd ? `office-${book.revision}-${sheet}-${active.row}-${active.col}` : undefined}
			inert={frozen} className={cn("relative min-h-0 min-w-0 flex-1 text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring", frozen ? "overflow-hidden" : "overflow-auto")}
			onScroll={event => { const element = event.currentTarget; setView(value => ({ ...value, top: element.scrollTop, left: element.scrollLeft })); }}
			onKeyDown={event => {
				let { row, col } = active;
				if (event.key === "ArrowDown") row++; else if (event.key === "ArrowUp") row--;
				else if (event.key === "ArrowRight") col++; else if (event.key === "ArrowLeft") col--;
				else if (event.key === "PageDown") row += Math.max(1, Math.floor(view.height / view.rowHeight) - 1);
				else if (event.key === "PageUp") row -= Math.max(1, Math.floor(view.height / view.rowHeight) - 1);
				else if (event.key === "Home") { col = 0; if (event.ctrlKey || event.metaKey) row = 0; }
				else if (event.key === "End") { col = meta.cols - 1; if (event.ctrlKey || event.metaKey) row = meta.rows - 1; }
				else return;
				event.preventDefault(); row = Math.max(0, Math.min(meta.rows - 1, row)); col = Math.max(0, Math.min(meta.cols - 1, col)); setActive({ row, col });
				const element = event.currentTarget;
				if (row * view.rowHeight < element.scrollTop) element.scrollTop = row * view.rowHeight;
				else if ((row + 2) * view.rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = (row + 2) * view.rowHeight - element.clientHeight;
				if (col * 160 < element.scrollLeft) element.scrollLeft = col * 160;
				else if ((col + 1) * 160 + 48 > element.scrollLeft + element.clientWidth) element.scrollLeft = (col + 1) * 160 + 48 - element.clientWidth;
			}}>
			<div className="relative" style={{ width: (restored ? (shown?.colEnd ?? 0) - colOffset : meta.cols) * 160 + 48, height: ((restored ? shown?.cells.length ?? 0 : meta.rows) + 1) * view.rowHeight }}>
				<div role="row" aria-rowindex={1} className="sticky top-0 z-10 border-b border-border bg-inset" style={{ height: view.rowHeight }}>
					<div role="columnheader" aria-colindex={1} className="sticky left-0 z-10 h-full w-12 border-r border-border bg-inset" />
					{window && Array.from({ length: Math.max(0, window.colEnd - window.colStart) }, (_, offset) => { const col = window.colStart + offset; return <div key={col} role="columnheader" aria-colindex={col + 2} className="absolute top-0 flex items-center border-r border-border px-2 font-medium text-fg-muted" style={{ left: (col - colOffset) * 160 + 48, width: 160, height: view.rowHeight }}>{columnName(col)}</div>; })}
				</div>
				{shown?.cells.map((values, offset) => { const row = shown.rowStart + offset; return <div key={row} role="row" aria-rowindex={row + 2} className="absolute left-0 w-full border-b border-border" style={{ top: (row - rowOffset + 1) * view.rowHeight, height: view.rowHeight }}>
					<div role="rowheader" aria-colindex={1} className="sticky left-0 z-1 flex h-full w-12 items-center justify-end border-r border-border bg-inset px-2 tabular-nums text-fg-muted">{row + 1}</div>
					{values.map((value, offset) => { const col = shown.colStart + offset; return <div key={col} id={`office-${book.revision}-${sheet}-${row}-${col}`} role="gridcell" aria-colindex={col + 2} title={value}
						onClick={() => setActive({ row, col })} className={cn("absolute top-0 flex items-center overflow-hidden whitespace-pre border-r border-border px-2 text-fg", active.row === row && active.col === col ? "bg-selected outline-1 -outline-offset-1 outline-ring" : "bg-sheet")}
						style={{ left: (col - colOffset) * 160 + 48, width: 160, height: view.rowHeight }}><span className="truncate">{value}</span></div>; })}
				</div>; })}
			</div>
		</div>}
		{meta?.limited && <p className="shrink-0 p-1 text-xs text-fg-muted">{t("live.office.limits")}</p>}
		{failed && <WaitingForSave />}
	</div>;
}

export function Frame(props: LiveFrameProps) {
	const { t } = useTranslation("panes");
	const { frame, error } = usePreviewGrant(props);
	const [good, setGood] = useState<LoadedWorkbook | null>(null);
	const kept = useRef<OfficeWorkerClient | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const source = useRef<{ token: string; path: string | null }>({ token: "", path: null });
	if (frame && source.current.token !== frame.grant.token) source.current = { token: frame.grant.token, path: props.subject.path };
	useEffect(() => {
		kept.current?.dispose(); kept.current = null; setGood(null);
		if (error) { props.officeCache?.clear(); props.onOfficeCheck?.(null); }
	}, [props.subject.path, props.subject.format, error]);
	useEffect(() => {
		if (!frame || error || !props.subject.path || source.current.path !== props.subject.path) return;
		const path = props.subject.path;
		kept.current?.dispose();
		let current = true, published = false;
		let client: OfficeWorkerClient | null = null;
		void (async () => {
			try {
				const binary = await window.vomp.invoke("preview:readBinary", frame.grant.token);
				if (!current) return;
				if (!binary.ok) {
					if (binary.reason !== "incomplete") {
						props.officeCache?.clear(); kept.current = null; setGood(null);
					} else if (binary.reason === "incomplete" && !good) {
						const cached = props.officeCache?.read();
						if (cached?.format === "xlsx" && cached.path === path && cached.revision <= frame.revision) {
							setGood({ client: null, sheets: cached.sheets, revision: cached.revision, path, initial: cached.window });
						}
					}
					if (binary.reason === "unsafe" || binary.reason === "tooLarge") props.onOfficeCheck?.(false);
					else props.onOfficeCheck?.(binary.reason === "incomplete" && (good || props.officeCache?.read()) ? true : null);
					setFailure(binary.reason); return;
				}
				client = new OfficeWorkerClient(new XlsxWorker());
				const result = await client.request<{ sheets: OfficeSheet[] }>({ bytes: binary.bytes }, [binary.bytes.buffer]);
				if (!current) return;
				kept.current?.dispose(); kept.current = client; published = true;
				setGood({ client, sheets: result.sheets, revision: frame.revision, path }); setFailure(null);
				props.onOfficeCheck?.(true);
			} catch (cause) {
				if (current) {
					const reason = cause instanceof Error ? cause.message : "unsafe";
					setFailure(reason);
					props.onOfficeCheck?.(reason === "unsafe" || reason === "tooLarge" ? false : null);
				}
			}
			finally { if (!published) client?.dispose(); }
		})();
		return () => { current = false; if (!published) client?.dispose(); };
	}, [frame, props.subject.path, props.subject.format, error]);
	useEffect(() => () => { kept.current?.dispose(); }, []);
	return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
		{good && good.path === props.subject.path && good.revision <= props.subject.revision && <Grid key={`${good.path}:${good.revision}`} book={good} frozen={good.revision !== frame?.revision || !good.client}
			onPresentation={window => props.officeCache?.write({ format: "xlsx", path: good.path, revision: good.revision, sheets: good.sheets, window })} />}
		{(error || failure === "incomplete" || failure === "missing") && <WaitingForSave />}
		{failure && failure !== "incomplete" && failure !== "missing" && <p role="status" className="p-3 text-sm text-fg-muted">{t(failure === "timeout" ? "live.office.timeout" : "live.office.unsafe")}{failure === "timeout" && good && <> {t("live.office.retained")}</>}</p>}
	</div>;
}

export const adapter: LiveAdapter = { format: "xlsx", maxFps: 2, Frame };
