/** Language-server results use omp's request metadata and formatted response grammar. */
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { SYN_CLASS, tokenizeLines } from "../../features/panes/highlight";
import type { Tone } from "../parts";
import { Badge, InvalidArg, Kv, KvGrid, Note, Output, PathText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, languageFromPath, normalizeWs, num, replaceTabs, resultTextOf, str, truncate, visibleBidi } from "../util";
import { parseDiagnosticResult, parseLocationResult } from "./lsp-result";
import type { DiagnosticResult, LocationResult, LocationRow } from "./lsp-result";

const PAGE_ROWS = 24;

function severityTone(severity: string): Tone | undefined {
	switch (severity) {
		case "error": return "err";
		case "warning": return "warn";
		case "info": return "accent";
		default: return undefined;
	}
}

/** Kv row for an optional arg: hidden when absent, InvalidArg when mistyped. */
function ArgKv({ k, raw, val }: { k: string; raw: unknown; val: ReactNode }): ReactNode {
	if (raw === undefined) return null;
	return <Kv k={k}>{val == null || val === false ? <InvalidArg what={k} /> : val}</Kv>;
}

function MoreRows({ remaining, show }: { remaining: number; show(): void }): ReactNode {
	return remaining > 0 ? <button type="button" className="tv-expand" onClick={show}>Show {Math.min(PAGE_ROWS, remaining)} more result{remaining === 1 ? "" : "s"}</button> : null;
}

function DiagnosticNotes({ messages, tone }: { messages: string[]; tone: "err" | "warn" }): ReactNode {
	const [limit, setLimit] = useState(PAGE_ROWS);
	return <>
		{messages.slice(0, limit).map((message, index) => <Note key={index} tone={tone}><bdi dir="ltr">{visibleBidi(message)}</bdi></Note>)}
		<MoreRows remaining={messages.length - limit} show={() => setLimit(value => value + PAGE_ROWS)} />
	</>;
}

function DiagnosticRows({ parsed, failed }: { parsed: DiagnosticResult; failed: boolean }): ReactNode {
	const [limit, setLimit] = useState(PAGE_ROWS);
	const { rows, failures, warnings, unverified, files, other } = parsed;
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.severity, (counts.get(row.severity) ?? 0) + 1);
	const clean = rows.length + failures.length + warnings.length + unverified.length === 0 && !other && !failed;
	return (
		<>
			<span className="tv-badges">
				{files > 0 && <Badge>{files} file{files === 1 ? "" : "s"}</Badge>}
				{["error", "warning", "info", "hint"].map(severity => {
					const count = counts.get(severity);
					return count ? <Badge key={severity} tone={severityTone(severity)}>{count} {severity}{count === 1 ? "" : "s"}</Badge> : null;
				})}
				{failures.length > 0 && <Badge tone="err">{failures.length} file{failures.length === 1 ? "" : "s"} with server failures</Badge>}
				{unverified.length > 0 && <Badge tone="warn">{unverified.length} unverified file{unverified.length === 1 ? "" : "s"}</Badge>}
				{clean && <Badge tone="ok">No issues</Badge>}
			</span>
			<DiagnosticNotes messages={failures} tone="err" />
			<DiagnosticNotes messages={unverified} tone="warn" />
			<DiagnosticNotes messages={warnings} tone="warn" />
			{rows.length > 0 && <div className="tv-list">
				{rows.slice(0, limit).map((d, i) => (
					<Row key={i} k={<Badge tone={severityTone(d.severity)}>{d.severity}</Badge>}>
						<PathText path={d.file} sel={`${d.line}:${d.col}`} literal />
						<span className="tv-muted block"><bdi dir="ltr">{visibleBidi(d.message)}</bdi></span>
					</Row>
				))}
			</div>}
			<MoreRows remaining={rows.length - limit} show={() => setLimit(value => value + PAGE_ROWS)} />
			{other && <Output text={visibleBidi(other)} maxLines={12} />}
		</>
	);
}

function SourcePreview({ location }: { location: LocationRow }): ReactNode {
	const [limit, setLimit] = useState(8);
	const [characters, setCharacters] = useState(2000);
	const shown = location.context.slice(0, limit);
	const lines = useMemo(() => tokenizeLines(location.context.slice(0, limit).map(row => replaceTabs(visibleBidi(row.text.slice(0, characters)))), languageFromPath(location.file)), [location, limit, characters]);
	if (location.context.length === 0) return null;
	return (
		<div className="tv-out">
			<pre className="tv-pre">{lines.map((tokens, index) => (
				<span key={index} className={location.context[index].line === location.line ? "font-semibold" : undefined}>
					{index > 0 ? "\n" : ""}<span className="tv-faint">{location.context[index].line}: </span>
					<bdi dir="ltr">{tokens.map((token, i) => <span key={i} className={SYN_CLASS[token.role]}>{token.text}</span>)}{shown[index].text.length > characters ? "…" : ""}</bdi>
				</span>
			))}</pre>
			{shown.some(row => row.text.length > characters) && <button type="button" className="tv-expand" onClick={() => setCharacters(value => value + 2000)}>Show more source text</button>}
			{location.context.length > limit && <button type="button" className="tv-expand" onClick={() => setLimit(value => value + 8)}>Show {Math.min(8, location.context.length - limit)} more source lines</button>}
		</div>
	);
}

function LocationRows({ parsed }: { parsed: LocationResult }): ReactNode {
	const [limit, setLimit] = useState(PAGE_ROWS);
	const groups = new Map<string, LocationRow[]>();
	for (const location of parsed.rows.slice(0, limit)) {
		const group = groups.get(location.file);
		if (group) group.push(location);
		else groups.set(location.file, [location]);
	}
	return (
		<>
			<span className="tv-badges"><Badge tone="accent">{parsed.count} {parsed.noun}{parsed.count === 1 ? "" : "s"}</Badge></span>
			{[...groups].map(([file, locations]) => <div className="tv-list" key={file}>
				{locations.map((location, index) => <Row key={index}>
					<PathText path={file} sel={`${location.line}:${location.col}`} literal />
					<SourcePreview location={location} />
				</Row>)}
			</div>)}
			<MoreRows remaining={parsed.rows.length - limit} show={() => setLimit(value => value + PAGE_ROWS)} />
			{parsed.other && <Output text={visibleBidi(parsed.other)} maxLines={12} />}
		</>
	);
}

function requestArgs({ args, result }: ToolRenderProps): Record<string, unknown> {
	const details = detailsRecord(result);
	const request = details && isRecord(details.request) ? details.request : {};
	const merged = { ...request, ...args };
	if (merged.action === undefined && details) merged.action = details.action;
	return merged;
}

function Summary(props: ToolRenderProps): ReactNode {
	const args = requestArgs(props);
	const action = str(args.action);
	const file = str(args.file);
	const line = num(args.line);
	const symbol = str(args.symbol);
	const query = str(args.query);
	const newName = str(args.new_name);
	return (
		<>
			<Badge tone="accent">{action ? action.replace(/_/g, " ") : "request"}</Badge>
			{file === "*" && <Badge>workspace</Badge>}
			{file && file !== "*" && <PathText path={file} from={line} />}
			{!file && line != null && <span className="tv-faint">line {line}</span>}
			{symbol && <span className="tv-pattern">{truncate(normalizeWs(symbol), 48)}</span>}
			{query && <span className="tv-muted">{truncate(normalizeWs(query), 48)}</span>}
			{newName && <span className="tv-muted">→ {truncate(normalizeWs(newName), 48)}</span>}
		</>
	);
}

function Body(props: ToolRenderProps): ReactNode {
	const { result } = props;
	const args = requestArgs(props);
	const details = detailsRecord(result);
	const file = str(args.file);
	const line = num(args.line);
	const symbol = str(args.symbol);
	const query = str(args.query);
	const newName = str(args.new_name);
	const apply = typeof args.apply === "boolean" ? args.apply : null;
	const timeout = num(args.timeout);
	const payload = str(args.payload);
	const serverName = details ? str(details.serverName) : null;
	const action = str(args.action);
	const failed = result?.isError === true || details?.success === false;
	const text = resultTextOf(result);
	const locations = !failed && text ? parseLocationResult(text, action) : null;
	const diagnostics = !locations && text ? parseDiagnosticResult(text, action) : null;

	return (
		<>
			<KvGrid>
				<ArgKv k="action" raw={args.action} val={str(args.action)?.replace(/_/g, " ")} />
				<ArgKv
					k="file"
					raw={args.file}
					val={file === "*" ? <Badge>workspace</Badge> : file && <PathText path={file} from={line} />}
				/>
				{!file && <ArgKv k="line" raw={args.line} val={line} />}
				<ArgKv k="symbol" raw={args.symbol} val={symbol && truncate(normalizeWs(symbol), 120)} />
				<ArgKv k="query" raw={args.query} val={query && truncate(normalizeWs(query), 120)} />
				<ArgKv k="new name" raw={args.new_name} val={newName && truncate(normalizeWs(newName), 120)} />
				<ArgKv k="apply" raw={args.apply} val={apply == null ? null : apply ? "yes" : "no"} />
				<ArgKv k="timeout" raw={args.timeout} val={timeout != null && `${timeout}s`} />
				{args.payload !== undefined && payload == null && (
					<Kv k="payload">
						<InvalidArg what="payload" />
					</Kv>
				)}
				{serverName && <Kv k="server"><bdi dir="ltr">{visibleBidi(serverName)}</bdi></Kv>}
			</KvGrid>
			{payload && <Output text={payload} lang="json" variant="code" maxLines={8} title="payload" />}
			{failed && <Badge tone="err">Request failed</Badge>}
			{locations ? (
				<LocationRows parsed={locations} />
			) : diagnostics ? (
				<DiagnosticRows parsed={diagnostics} failed={failed} />
			) : (
				text && <Output text={visibleBidi(text)} error={failed} maxLines={12} />
			)}
		</>
	);
}

export const lspRenderer: ToolRenderer = { Summary, Body };
