/** `read` — file/URL/archive reads: path + selector summary, highlighted content, image thumbnails. */
import type { ReactNode } from "react";
import { Badge, Badges, Kv, KvGrid, PathText, ResultImages, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, languageFromPath, num, shortenPath, splitReadQuery, str } from "../util";

/** Fields of `ReadToolDetails` the web view surfaces (untrusted wire JSON). */
interface ReadDetails {
	resolvedPath: string | null;
	suffixTo: string | null;
	suffixFrom: string | null;
	elidedSpans: number | null;
	conflictCount: number | null;
	truncated: boolean;
}

function readDetails(details: Record<string, unknown> | null): ReadDetails {
	const suffix = details && isRecord(details.suffixResolution) ? details.suffixResolution : null;
	const summary = details && isRecord(details.summary) ? details.summary : null;
	return {
		resolvedPath: details ? str(details.resolvedPath) : null,
		suffixTo: suffix ? str(suffix.to) : null,
		suffixFrom: suffix ? str(suffix.from) : null,
		elidedSpans: summary ? num(summary.elidedSpans) : null,
		conflictCount: details ? num(details.conflictCount) : null,
		truncated: details ? isRecord(details.truncation) : false,
	};
}

// Selector grammar from omp's `pi-tui` tools/read.ts and line-ranges.ts (18.19.0). Path splitting peels only complete
// selectors: a range ends in a digit, `.` or `-` (`5-`, `5..`), never a trailing `+` or `L`.
const RANGE_CHUNK_SRC = String.raw`L?(?:\d+)(?:(?:\.\.|[-+])L?(?:\d+)?)?(?<=[\d.-])`;
/** A list mixes ranges and tails (`-N` reads the last N lines): `1-12,-15`. */
const RANGE_LIST_SRC = String.raw`(?:${RANGE_CHUNK_SRC}|-\d+)(?:,(?:${RANGE_CHUNK_SRC}|-\d+))*`;
const SEL_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|raw|conflicts|img)$`, "i");
const LIST_ONLY_RE = new RegExp(`^(?:${RANGE_LIST_SRC})$`, "i");
const RAW_ONLY_RE = /^raw$/i;
const BARE_LINE_RE = /^\d+$/;

/**
 * Fold list chunks that a colon split off inside one comma list into the list after them: the selector colon repeated
 * after a comma (`a:1-30,:-30` reads as `a:1-30,-30`), and from omp 18.19.0 a colon written as the range dash
 * (`a:20:40,85:100` reads as `a:20-40,85-100`). The dash form folds only into a list with a comma, so `clip.mp4:1:30`
 * and `a.ts:12:5` keep their colons.
 */
function foldListColons(basePath: string, list: string): { basePath: string; list: string } {
	// Comma chunks, last first: the list's first chunk is always the last element.
	const chunks = list.split(",").reverse();
	let base = basePath;
	let dashed = false;
	while (true) {
		const colon = base.lastIndexOf(":");
		if (colon < 1) break;
		const head = base.slice(colon + 1);
		if (head.endsWith(",")) {
			const repeated = head.slice(0, -1);
			if (!LIST_ONLY_RE.test(repeated)) break;
			chunks.push(...repeated.split(",").reverse());
		} else {
			const headChunks = head.split(",");
			const start = headChunks.pop() ?? "";
			const end = chunks[chunks.length - 1] ?? "";
			if (!BARE_LINE_RE.test(start) || !BARE_LINE_RE.test(end)) break;
			if (headChunks.length > 0 && !LIST_ONLY_RE.test(headChunks.join(","))) break;
			chunks[chunks.length - 1] = `${start}-${end}`;
			chunks.push(...headChunks.reverse());
			dashed = true;
		}
		base = base.slice(0, colon);
	}
	if (dashed && chunks.length === 1) return { basePath, list };
	return { basePath: base, list: chunks.reverse().join(",") };
}

/** Split a `path:sel` argument the way omp reads it: one line list and `raw` in either order, or one other selector. */
export function splitPathSel(rawPath: string): { path: string; sel: string | null; query: string | null } {
	const query = splitReadQuery(rawPath);
	const whole = { path: query.path, sel: null, query: query.query };
	const colon = query.path.lastIndexOf(":");
	if (colon <= 0) return whole;
	const candidate = query.path.slice(colon + 1);
	if (!SEL_RE.test(candidate)) return whole;
	let basePath = query.path.slice(0, colon);
	let list: string | undefined;
	let rawSuffix = "";
	if (LIST_ONLY_RE.test(candidate)) list = candidate;
	else if (RAW_ONLY_RE.test(candidate)) {
		const inner = basePath.lastIndexOf(":");
		const innerCandidate = basePath.slice(inner + 1);
		if (inner > 0 && LIST_ONLY_RE.test(innerCandidate)) {
			list = innerCandidate;
			rawSuffix = `:${candidate}`;
			basePath = basePath.slice(0, inner);
		}
	}
	if (list === undefined) return { path: basePath, sel: candidate, query: query.query };
	({ basePath, list } = foldListColons(basePath, list));
	if (!rawSuffix) {
		const inner = basePath.lastIndexOf(":");
		const innerCandidate = basePath.slice(inner + 1);
		if (inner > 0 && RAW_ONLY_RE.test(innerCandidate)) return { path: basePath.slice(0, inner), sel: `${innerCandidate}:${list}`, query: query.query };
	}
	return { path: basePath, sel: `${list}${rawSuffix}`, query: query.query };
}

interface ReadArgs {
	path: string;
	sel: string | null;
	query: string | null;
	from: number | null;
	to: number | null;
}

function readArgs(args: Record<string, unknown>): ReadArgs {
	const rawPath = str(args.path) ?? str(args.file_path) ?? "";
	const split = splitPathSel(rawPath);
	const sel = str(args.sel) ?? split.sel;
	const offset = num(args.offset);
	const limit = num(args.limit);
	const from = offset !== null || limit !== null ? (offset ?? 1) : null;
	const to = from !== null && limit !== null ? from + limit - 1 : null;
	return { path: split.path || rawPath, sel, query: split.query, from, to };
}

function Summary(props: ToolRenderProps): ReactNode {
	const { path, sel, query, from, to } = readArgs(props.args);
	return <><PathText path={path || "…"} from={from} to={to} sel={sel} />{query !== null && <span className="tv-read-query"><Badge>jq: {query}</Badge></span>}</>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const { path, query } = readArgs(args);
	const d = readDetails(detailsRecord(result));
	const conflictBadge = d.conflictCount !== null && d.conflictCount > 0 && (
		<Badge tone="warn">
			{d.conflictCount} conflict{d.conflictCount === 1 ? "" : "s"}
		</Badge>
	);
	const elidedBadge = d.elidedSpans !== null && d.elidedSpans > 0 && (
		<Badge>
			{d.elidedSpans} elided span{d.elidedSpans === 1 ? "" : "s"}
		</Badge>
	);
	const truncatedBadge = d.truncated && <Badge tone="warn">truncated</Badge>;
	const resolved = d.suffixTo ?? d.resolvedPath;
	return (
		<>
			{query !== null && <span className="tv-read-query"><Badge>jq: {query}</Badge></span>}
			{(resolved !== null || d.suffixFrom !== null) && (
				<KvGrid>
					{resolved !== null && (
						<Kv k="resolved">
							<PathText path={resolved} literal />
						</Kv>
					)}
					{d.suffixFrom !== null && <Kv k="corrected from">{shortenPath(d.suffixFrom)}</Kv>}
				</KvGrid>
			)}
			<Badges items={[conflictBadge, elidedBadge, truncatedBadge]} />
			<ResultImages result={result} paths={[resolved ?? path]} literalPaths={resolved !== null} />
			<ResultText result={result} maxLines={12} lang={languageFromPath(path)} variant="code" />
		</>
	);
}

export const readRenderer: ToolRenderer = { Summary, Body };
