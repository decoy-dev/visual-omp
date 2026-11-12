import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowClockwise, CaretRight, CheckCircle, Circle, Copy, Info, Pause, Play, SkipBack, SkipForward, SlidersHorizontal, Warning, XCircle } from "@phosphor-icons/react";
import type { TFunction } from "i18next";
import { shellPresentation, type ShellVizPresentation, type TspShellProps } from "@shared/tsp/shell";
import { Button, IconButton } from "../../ui/Button";
import { Menu, MenuCheckboxItem, MenuContent, MenuSeparator, MenuTrigger } from "../../ui/Menu";
import { Segmented } from "../../ui/Segmented";
import { Output as TextOutput } from "../../tool-render/parts";
import { useDeferredTranslation } from "../../i18n";
import "./shell.css";
import type { ShellCommandContext } from "../../tool-render/types";
import { RunByteValues } from "./RunByteValues";

type Row = ShellVizPresentation["rows"][number];
type Segment = Row["segments"][number];
type Watch = NonNullable<Row["annotations"]>[number];
type Translate = TFunction<"tools">;
const layers = ["color", "inline", "idioms", "effects", "unwrap"] as const;
const states = { pending: Circle, running: Play, ok: CheckCircle, fail: XCircle, skipped: SkipForward } as const;
function Status({ state, t }: { state?: Row["state"]; t: Translate }) {
	if (!state) return <span className="shell-status" aria-hidden />;
	const label = t(`state.${state}`);
	const Icon = states[state];
	return <span className="shell-status" data-state={state} title={label}><Icon aria-hidden /><span className="sr-only">{label}</span></span>;
}
function syntax(segment: Segment, color: boolean): string | undefined {
	const tokens = segment.style?.split(" ") ?? [];
	if (!color && !tokens.some(token => ["chip", "badge", "secret"].includes(token))) return undefined;
	if (tokens.includes("comment")) return "comment";
	if (tokens.includes("kw")) return "keyword";
	if (tokens.includes("var") || tokens.includes("secret")) return "type";
	if (tokens.includes("str") || tokens.includes("path")) return "string";
	if (tokens.includes("num")) return "number";
	if (tokens.includes("op")) return "operator";
	if (tokens.includes("cmd") || tokens.includes("fn")) return "function";
	if (tokens.includes("chip") || tokens.includes("badge")) return "accent";
	return undefined;
}
function nodeKey(row: Row): string | undefined { return row.node ?? row.segments.find(segment => segment.node)?.node; }
function rowCommands(row: Row): string[] {
	return [...new Set([row.node, ...row.segments.map(segment => segment.node)].filter((key): key is string => key !== undefined))];
}
const valueEncoder = new TextEncoder();
function Value({ watch, expanded = false, t }: { watch: Watch; expanded?: boolean; t: Translate }) {
	const [open, setOpen] = useState(false);
	const long = watch.value.length > 240;
	const truncated = watch.fullLength !== undefined && watch.fullLength > valueEncoder.encode(watch.value).length;
	return <span className="shell-value"><bdi>{watch.name}</bdi> = <bdi>{open || !long ? watch.value : `${watch.value.slice(0, 240)}…`}</bdi>{watch.scope && <span className="shell-meta"> ({watch.scope})</span>}{truncated && <span className="shell-meta">{t("retainedValue", { length: watch.fullLength })}</span>}{expanded && long && <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{t(open ? "showLessValue" : "showRetainedValue")}</Button>}{!expanded && long && <span className="shell-meta">{t("inspectValue")}</span>}</span>;
}

function Rows({ rows, label, showLabel = false, presentation, limit, start = 0, disabled, action, inspect, localRow, annotationLimit, t }: { rows: Row[]; label: string; showLabel?: boolean; presentation: ShellVizPresentation; limit: number; start?: number; disabled: boolean; action: (value: string) => void; inspect: (id: string | undefined) => void; localRow?: string; annotationLimit: number; t: Translate }) {
	const list = useRef<HTMLDivElement>(null);
	const selected = presentation.preferences.selectedNode;
	const [focus, setFocus] = useState<string>();
	const [commandFocus, setCommandFocus] = useState<{ row: string; key: string }>();
	const dragged = useRef(false);
	const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
	const hintId = useId();
	const visible = rows.slice(start, start + limit);
	const focusRow = visible.find(row => row.id === focus) ?? visible.find(row => selected !== undefined && rowCommands(row).includes(selected)) ?? visible[0];
	const activeKey = (row: Row) => commandFocus?.row === row.id && rowCommands(row).includes(commandFocus.key) ? commandFocus.key : nodeKey(row);
	const choose = (row: Row, key = activeKey(row)) => {
		if (dragged.current || window.getSelection()?.toString()) return;
		if (key && !disabled) { inspect(undefined); action(`select:${key}`); }
		else inspect(row.id);
	};
	const navigate = (event: KeyboardEvent<HTMLDivElement>, row: Row) => {
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			const keys = rowCommands(row);
			const index = keys.indexOf(activeKey(row) ?? "");
			const key = keys[Math.max(0, Math.min(keys.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)))];
			if (key) { event.preventDefault(); event.stopPropagation(); setCommandFocus({ row: row.id, key }); }
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			const key = activeKey(row);
			event.preventDefault(); event.stopPropagation();
			if (key && !disabled) { inspect(undefined); action(`select:${key}`); }
			else inspect(row.id);
			return;
		}
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const selectable = visible;
		const index = selectable.indexOf(row);
		const next = event.key === "Home" ? selectable[0] : event.key === "End" ? selectable.at(-1) : selectable[Math.max(0, Math.min(selectable.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
		if (next) {
			event.preventDefault(); event.stopPropagation(); setFocus(next.id);
			const index = visible.indexOf(next);
			list.current?.querySelectorAll<HTMLElement>("[data-shell-row]")[index]?.focus();
		}
	};
	let annotationsLeft = annotationLimit;
	return <section className="shell-pane" aria-label={label}>{showLabel && <h4 className="shell-pane-label">{label}</h4>}<p id={hintId} className="sr-only">{t("commandNavigation")}</p><div ref={list} role="listbox" aria-label={t("commandRows", { label })} aria-disabled={disabled}>
		{visible.map(row => {
			const picked = localRow ? localRow === row.id : selected !== undefined && (row.node === selected || row.segments.some(segment => segment.node === selected));
			const annotations = (row.annotations ?? []).slice(0, annotationsLeft);
			annotationsLeft -= annotations.length;
			let failedExecutions: Set<string> | undefined;
			const keys = rowCommands(row);
			const target = activeKey(row);
			const targetText = row.segments.filter(segment => segment.node === target).map(segment => segment.text).join("").trim() || row.segments.map(segment => segment.text).join("");
			return <div key={row.id} data-shell-row={row.id} role="option" aria-selected={picked} aria-describedby={hintId} aria-label={keys.length > 1 ? t("commandTarget", { position: keys.indexOf(target!) + 1, total: keys.length, command: targetText, state: row.state ? t(`state.${row.state}`) : "" }) : undefined} tabIndex={row === focusRow ? 0 : -1} className="shell-row" data-selected={picked || undefined} data-inactive={presentation.running && !row.active || row.state === "skipped" || undefined} onFocus={() => setFocus(row.id)} onKeyDown={event => navigate(event, row)} onPointerDown={event => { dragged.current = false; pointer.current = { x: event.clientX, y: event.clientY }; }} onPointerMove={event => { if (pointer.current && event.buttons && Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 4) dragged.current = true; }} onClick={() => choose(row)}>
				<Status state={row.state === "fail" && row.segments.some(segment => segment.state === "fail") ? undefined : row.state} t={t} /><div className="shell-row-body" style={{ "--shell-depth": Math.min(row.depth, 24) } as CSSProperties}><code dir="auto">{row.segments.map((segment, index) => {
					const execution = segment.executionNode ?? segment.node ?? row.node ?? row.id;
					const failed = segment.state === "fail" && !failedExecutions?.has(execution);
					if (failed) (failedExecutions ??= new Set()).add(execution);
					return <span key={index} data-syntax={syntax(segment, presentation.preferences.layers.color)} data-state={segment.state} data-active={segment.active || undefined} data-keyboard-target={commandFocus?.row === row.id && segment.node === target || undefined} data-inactive={presentation.running && !(segment.active ?? row.active) || segment.state === "skipped" || undefined} title={segment.tip} onClick={event => { if (segment.node && !disabled) { event.stopPropagation(); choose(row, segment.node); } }}>{failed && <span className="shell-segment-failure"><XCircle aria-hidden /><span className="sr-only">{t("segmentFailed")}</span></span>}{segment.text}</span>;
				})}</code>{row.meta && <span className="shell-meta"> {row.meta}</span>}
					{annotations.map((watch, index) => <div key={index} className="shell-annotation"><Value watch={watch} t={t} /></div>)}{(row.annotations?.length ?? 0) > annotations.length && <span className="shell-meta">{t("moreValues")}</span>}
					{presentation.preferences.layers.effects && row.effects.length > 0 && <span className="shell-effects">{row.effects.slice(0, 50).map((effect, index) => <span key={index} title={effect.why}><Warning aria-hidden />{effect.label}</span>)}{row.effects.length > 50 && <span>{t("moreEffects")}</span>}</span>}
				</div>
			</div>;
		})}
	</div></section>;
}

function Details({ presentation, command, disabled, action, localRow, t }: { presentation: ShellVizPresentation; command?: string; disabled: boolean; action: (value: string) => void; localRow?: string; t: Translate }) {
	const [page, setPage] = useState(0);
	const selected = localRow ? undefined : presentation.preferences.selectedNode;
	const row = localRow ? presentation.rows.find(row => row.id === localRow) ?? presentation.original.find(row => row.id === localRow) : presentation.rows.find(row => selected !== undefined && (row.node === selected || row.segments.some(segment => segment.node === selected))) ?? presentation.original.find(row => selected !== undefined && (row.node === selected || row.segments.some(segment => segment.node === selected)));
	useEffect(() => setPage(0), [selected, localRow]);
	if (!row) return <details className="shell-details"><summary>{t("details")}</summary><p>{t("selectRow")}</p></details>;
	const segment = row.segments.find(segment => segment.node === selected);
	const range = segment?.range ?? row.range;
	const candidate = command !== undefined && range && range[1] <= command.length ? command.slice(range[0], range[1]) : undefined;
	// omp may prepend a configured shell prefix. Only quote a caller-source slice the canonical detail confirms.
	const source = candidate && row.detail?.startsWith(candidate) ? candidate : undefined;
	const detail = source !== undefined ? row.detail?.slice(source.length).trimStart() : row.detail;
	const annotations = row.annotations ?? [];
	const items = [
		...(source !== undefined ? [{ label: t("originalSource"), text: source }] : []),
		...(detail ? [{ label: t("commandDetails"), text: detail }] : []),
		...row.segments.flatMap(segment => [
			...(segment.tip ? [{ label: t("explanation"), text: segment.tip }] : []),
			...(segment.expanded ? [{ label: t("expandedText"), text: segment.expanded }] : []),
		]),
		...row.effects.map(effect => ({ label: effect.label, text: effect.why })),
	];
	const total = items.length + annotations.length;
	const offset = Math.min(page, Math.max(0, Math.ceil(total / 50) - 1)) * 50;
	return <details className="shell-details" open key={selected ?? localRow}><summary>{t("details")}</summary><div className="shell-detail-content" tabIndex={-1}>
		{row.state && <p className="shell-detail-status"><Status state={row.state} t={t} />{t(`state.${row.state}`)}{row.meta && `: ${row.meta}`}</p>}
		{selected && <Button size="sm" variant="ghost" disabled={disabled} aria-pressed={presentation.preferences.expandedNodes.includes(selected)} onClick={() => action(`expand:${selected}`)}>{t(presentation.preferences.expandedNodes.includes(selected) ? "collapseCommand" : "expandCommand")}</Button>}
		<dl>{items.slice(offset, offset + 50).map((item, index) => <div key={index}><dt>{item.label}</dt><dd dir="auto">{item.text}</dd></div>)}{annotations.slice(Math.max(0, offset - items.length), Math.max(0, offset + 50 - items.length)).map((watch, index) => <div key={`watch-${offset}-${index}`}><dt>{t("observedValue")}</dt><dd><Value watch={watch} expanded t={t} /></dd></div>)}</dl>
		{total === 0 && <p>{t("noDetails")}</p>}{total > 50 && <div className="shell-replay-buttons"><Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setPage(Math.max(0, page - 1))}>{t("previousDetails")}</Button><Button size="sm" variant="ghost" disabled={offset + 50 >= total} onClick={() => setPage(page + 1)}>{t("nextDetails")}</Button><span className="shell-meta">{t("detailsPage", { start: offset + 1, end: Math.min(total, offset + 50), total })}</span></div>}
		{row.effects.length > 0 && <p className="shell-meta">{t("effectDisclaimer")}</p>}
	</div></details>;
}

function Output({ text, replay, t }: { text: string | undefined; replay: boolean; t: Translate }) {
	return <section className="shell-output" aria-label={t(replay ? "replayOutput" : "output")}><h4>{t(replay ? "replayOutput" : "output")}</h4>{text === undefined ? <p>{t("returnLatest")}</p> : text ? <TextOutput text={text} maxLines={20} bare /> : <p>{t("noOutput")}</p>}</section>;
}
export function ShellView({ props, command, context, disabled = false, onAction, showOutput = true }: { props: TspShellProps; command?: string; context?: ShellCommandContext; disabled?: boolean; onAction?: (value: string) => void; showOutput?: boolean }) {
	const { t } = useDeferredTranslation("shellVisualization");
	const presentation = shellPresentation(props?.presentation);
	const [replay, setReplay] = useState(!!props?.inspector || !!presentation && presentation.preferences.cursor !== undefined);
	const [expanded, setExpanded] = useState(false);
	const [rowPage, setRowPage] = useState(0);
	const [originalOutput, setOriginalOutput] = useState(false);
	const [copyState, setCopyState] = useState("");
	const [localRow, setLocalRow] = useState<string>();
	const [announcement, setAnnouncement] = useState("");
	const pendingNavigation = useRef<{ cursor?: number; latest: boolean } | undefined>(undefined);
	const [seekDraft, setSeekDraft] = useState<number>();
	const pendingSeek = useRef<{ cursor: number; timer: number } | undefined>(undefined);
	const view = useRef<HTMLDivElement>(null);
	const focusedRow = useRef<HTMLElement | null>(null);
	const sliderId = useId();
	const replayButton = useRef<HTMLButtonElement>(null);
	const latest = useRef<{ callback?: (value: string) => void; disabled: boolean; replay: boolean; playing: boolean }>({ disabled, replay, playing: false });
	latest.current = { callback: presentation ? onAction : undefined, disabled, replay: replay || !!props?.inspector, playing: !!presentation?.preferences.playing };
	const latestOutput = useRef<string | undefined>(undefined);
	if (presentation && presentation.preferences.cursor === undefined) latestOutput.current = presentation.output;
	const blocked = disabled || !onAction;
	const action = (value: string) => { if (!blocked) onAction?.(value); };
	useEffect(() => {
		const pause = () => {
			const state = latest.current;
			if (!state.disabled && (state.replay || state.playing)) state.callback?.("pause");
		};
		const hidden = () => {
			if (!document.hidden) return;
			clearTimeout(pendingSeek.current?.timer);
			pendingSeek.current = undefined;
			setSeekDraft(undefined);
			pause();
		};
		document.addEventListener("visibilitychange", hidden);
		if (document.hidden) pause();
		return () => { document.removeEventListener("visibilitychange", hidden); pause(); };
	}, []);
	useEffect(() => {
		if (!replay && !props?.inspector && presentation?.preferences.playing) action("pause");
	}, [replay, props?.inspector, presentation?.preferences.playing, blocked]);
	useEffect(() => {
		if (focusedRow.current && !focusedRow.current.isConnected && document.activeElement === document.body) {
			view.current?.querySelector<HTMLElement>(".shell-details summary")?.focus();
			focusedRow.current = null;
		}
	}, [presentation]);
	useEffect(() => () => { clearTimeout(pendingSeek.current?.timer); }, []);
	useEffect(() => {
		if (seekDraft !== undefined && presentation?.timeline.cursor === seekDraft && !pendingSeek.current) setSeekDraft(undefined);
	}, [presentation, seekDraft]);
	useEffect(() => {
		const pending = pendingNavigation.current;
		if (!presentation || !pending) return;
		const acknowledged = pending.latest ? presentation.preferences.cursor === undefined : presentation.preferences.cursor !== undefined && presentation.timeline.cursor === pending.cursor;
		if (!acknowledged) return;
		pendingNavigation.current = undefined;
		setAnnouncement(t("position", { cursor: presentation.timeline.cursor, length: presentation.timeline.length, elapsed: (presentation.timeline.elapsedNs / 1e9).toFixed(2), duration: (presentation.timeline.durationNs / 1e9).toFixed(2), mode: t(pending.latest ? "latest" : "viewingReplay") }));
	}, [presentation, t]);
	if (!presentation) return <div className="shell-view shell-unavailable"><p>{t("unavailable")}</p>{command !== undefined && <pre dir="auto">{command}</pre>}</div>;
	const { preferences, timeline } = presentation;
	const replayOpen = replay || !!props.inspector;
	const held = preferences.cursor !== undefined;
	const split = preferences.split && preferences.view === "pseudo";
	const paneLimit = split ? 100 : 200;
	const showingPreview = !expanded && !replayOpen;
	const preview = showingPreview ? Math.max(1, Math.min(paneLimit, props.preview?.lines ?? 12)) : paneLimit;
	const maxRows = Math.max(presentation.rows.length, split ? presentation.original.length : 0);
	const pageOffset = showingPreview ? 0 : Math.min(rowPage, Math.max(0, Math.ceil(maxRows / paneLimit) - 1)) * paneLimit;
	const output = held && (!replayOpen || originalOutput) ? latestOutput.current : presentation.output;
	const position = t("position", { cursor: timeline.cursor, length: timeline.length, elapsed: (timeline.elapsedNs / 1e9).toFixed(2), duration: (timeline.durationNs / 1e9).toFixed(2), mode: t(held ? "viewingReplay" : "latest") });
	const cancelSeek = () => {
		clearTimeout(pendingSeek.current?.timer);
		pendingSeek.current = undefined;
		setSeekDraft(undefined);
	};
	const seek = (cursor: number) => {
		pendingNavigation.current = undefined;
		setAnnouncement("");
		setOriginalOutput(false);
		setSeekDraft(cursor);
		if (pendingSeek.current) { pendingSeek.current.cursor = cursor; return; }
		pendingSeek.current = { cursor, timer: window.setTimeout(() => {
			const pending = pendingSeek.current;
			pendingSeek.current = undefined;
			if (pending && !latest.current.disabled) latest.current.callback?.(`seek:${pending.cursor}`);
		}, 80) };
	};
	const togglePlayback = () => {
		const cursor = pendingSeek.current?.cursor;
		cancelSeek();
		if (cursor !== undefined) action(`seek:${cursor}`);
		action(preferences.playing ? "pause" : "play");
	};
	const navigateReplay = (value: string, cursor?: number) => {
		if (blocked) return;
		cancelSeek();
		pendingNavigation.current = { cursor, latest: value === "live" };
		setAnnouncement("");
		setOriginalOutput(false);
		action(value);
	};
	const copy = async () => {
		if (command === undefined) return;
		try { await navigator.clipboard.writeText(command); setCopyState("copySuccess"); }
		catch { setCopyState("copyFailed"); }
	};
	const closeReplay = () => {
		cancelSeek(); pendingNavigation.current = undefined;
		action("pause"); action("live"); setReplay(false); setOriginalOutput(false); replayButton.current?.focus();
	};
	return <div ref={view} className="shell-view" data-replay-epoch={props.replayEpoch} aria-live="off" onFocusCapture={event => { focusedRow.current = event.target.closest<HTMLElement>("[data-shell-row]"); }}>
		<div className="shell-toolbar"><div className="shell-view-switch"><Segmented aria-label={t("presentation")} indicatorMotion={false} value={preferences.view} options={[{ value: "raw", label: t("raw") }, { value: "pseudo", label: t("pseudo") }]} size="sm" disabled={blocked} onValueChange={value => action(`view:${value}`)} /><IconButton size="sm" label={t("aboutPseudo")} tooltip={t("pseudoExplanation")} icon={<Info />} /></div>
			<Button size="sm" variant="ghost" icon={<Copy />} disabled={command === undefined} title={t(command === undefined ? "copyUnavailable" : "copyHint")} onClick={() => void copy()}>{t("copyCommand")}</Button>
			<Menu><MenuTrigger asChild><Button size="sm" variant="ghost" icon={<SlidersHorizontal />} disabled={blocked}>{t("displayOptions")}</Button></MenuTrigger><MenuContent>
				{layers.map(name => <MenuCheckboxItem key={name} checked={preferences.layers[name]} disabled={blocked} onCheckedChange={() => action(`layer:${name}`)} onSelect={event => event.preventDefault()}>{t(`layer.${name}`)}</MenuCheckboxItem>)}
				<MenuSeparator /><MenuCheckboxItem checked={split} disabled={blocked || preferences.view === "raw"} onCheckedChange={() => action("split")}>{t("split")}</MenuCheckboxItem>{preferences.view === "raw" && <p className="px-2 py-1 text-xs text-fg-muted">{t("splitUnavailable")}</p>}
			</MenuContent></Menu>
			{!props.inspector && <Button ref={replayButton} size="sm" variant="ghost" icon={<CaretRight />} aria-expanded={replayOpen} onClick={() => replayOpen ? closeReplay() : setReplay(true)}>{t("replay")}</Button>}
		</div>
		{(props.cwd ?? context?.cwd) && <pre className="shell-meta whitespace-pre-wrap break-words font-mono" data-shell-context><bdi>{`$ cd ${props.cwd ?? context?.cwd}${context?.cdSeparator ?? " &&"}`}</bdi></pre>}{presentation.message && <p className="shell-meta">{presentation.message}</p>}
		<div className="shell-panes" data-split={split || undefined}>
			{split && <Rows rows={presentation.original} label={t("original")} showLabel presentation={presentation} limit={preview} start={pageOffset} disabled={blocked} action={action} inspect={setLocalRow} localRow={localRow} annotationLimit={25} t={t} />}
			<Rows rows={presentation.rows} label={t(preferences.view)} showLabel={split} presentation={presentation} limit={preview} start={pageOffset} disabled={blocked} action={action} inspect={setLocalRow} localRow={localRow} annotationLimit={split ? 25 : 50} t={t} />
		</div>
		{showingPreview && maxRows > preview && <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>{t("moreRows", { count: maxRows - preview })}</Button>}
		{!showingPreview && maxRows > paneLimit && <div className="shell-replay-buttons"><Button size="sm" variant="ghost" disabled={pageOffset === 0} onClick={() => setRowPage(Math.max(0, rowPage - 1))}>{t("previousRows")}</Button><Button size="sm" variant="ghost" disabled={pageOffset + paneLimit >= maxRows} onClick={() => setRowPage(rowPage + 1)}>{t("nextRows")}</Button><span className="shell-meta">{t("rowsPage", { start: pageOffset + 1, end: Math.min(maxRows, pageOffset + paneLimit), total: maxRows })}</span></div>}
		<Details presentation={presentation} command={command} disabled={blocked} action={action} localRow={localRow} t={t} />
		<RunByteValues trace={context?.trace} />
		{replayOpen && <section className="shell-replay" aria-label={t("replayControls")}><h4>{t("replay")}</h4><p className="shell-meta">{t("replayExplanation")}</p>
			{timeline.trimmed && <p>{t("trimmed")}</p>}
			{timeline.length === 0 ? <p role="status">{t("emptyHistory")}</p> : <>
				<div className="shell-replay-buttons"><Button size="sm" variant="ghost" icon={<SkipBack />} disabled={blocked || timeline.cursor <= 0} onClick={() => navigateReplay(`seek:${Math.max(0, timeline.cursor - 1)}`, Math.max(0, timeline.cursor - 1))}>{t("previous")}</Button><Button size="sm" variant="ghost" icon={<SkipForward />} disabled={blocked || timeline.cursor >= timeline.length} onClick={() => navigateReplay("step", Math.min(timeline.length, timeline.cursor + 1))}>{t("next")}</Button><Button size="sm" variant="ghost" icon={<ArrowClockwise />} disabled={blocked} onClick={() => navigateReplay("reset", 0)}>{t("reset")}</Button><Button size="sm" variant="ghost" icon={preferences.playing ? <Pause /> : <Play />} disabled={blocked} onClick={togglePlayback}>{t(preferences.playing ? "pause" : "play")}</Button></div>
				<label htmlFor={sliderId}>{t("seek")}</label><input id={sliderId} type="range" min={0} max={timeline.length} step={1} value={seekDraft ?? timeline.cursor} disabled={blocked} aria-valuetext={seekDraft === undefined ? position : t("seekPending", { cursor: seekDraft, length: timeline.length })} onChange={event => seek(Number(event.currentTarget.value))} />
				<p className="shell-replay-position">{position}</p>
				<div className="shell-replay-footer"><Segmented aria-label={t("speed")} indicatorMotion={false} value={String(preferences.speed)} options={[0.5, 1, 2, 4].map(speed => ({ value: String(speed), label: t("speedValue", { speed }) }))} disabled={blocked} size="sm" onValueChange={speed => action(`speed:${speed}`)} /><Button size="sm" variant="ghost" disabled={blocked} onClick={() => navigateReplay("live")}>{t("latest")}</Button></div>
			</>}
			{!props.inspector && <Button size="sm" variant="ghost" onClick={closeReplay}>{t("closeReplay")}</Button>}
		</section>}
		{held && replayOpen && <div className="shell-output-choice"><span>{t(originalOutput ? "originalOutput" : "viewingReplay")}</span><Button size="sm" variant="ghost" aria-pressed={originalOutput} onClick={() => setOriginalOutput(!originalOutput)}>{t(originalOutput ? "replayOutput" : "originalOutput")}</Button><span className="shell-meta">{t("allOutput")}</span></div>}
		{(showOutput || held && replayOpen && !originalOutput) && <Output text={output} replay={held && replayOpen && !originalOutput} t={t} />}
		{held && replayOpen && originalOutput && !showOutput && <p className="shell-meta">{t("ordinaryOutput")}</p>}
		{copyState && <p role="status" className="shell-meta">{t(copyState)}</p>}
		<p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
	</div>;
}
