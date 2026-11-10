/** `grep` (legacy `search`): ripgrep content search across workspace files. */
import type { ReactNode } from "react";
import { SYN_CLASS, type SynRole, type SynToken } from "../../features/panes/highlight";
import { Badge, Badges, InvalidArg, Note, PathText, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, num, resultTextOf, scopePaths, shortenPath, str } from "../util";

/** Grep scope: current `path` (string, delimited, or JSON array) or legacy `paths`; defaults to workspace root. */
function pathsOf(args: Record<string, unknown>): string[] {
	const list = scopePaths(args);
	return list.length ? list : ["."];
}

/** Flag badges covering current and legacy arg dialects. */
function argBadges(args: Record<string, unknown>): ReactNode[] {
	const badges: ReactNode[] = [];
	const glob = str(args.glob);
	if (glob) badges.push(`glob=${glob}`);
	const type = str(args.type);
	if (type) badges.push(`type=${type}`);
	if (args.i === true) badges.push("i");
	if (args.multiline === true) badges.push("multiline");
	if (args.gitignore === false) badges.push("no-gitignore");
	const skip = num(args.skip);
	if (skip !== null && skip > 0) badges.push(`skip=${skip}`);
	return badges;
}

/** Keep streaming header work and its span count bounded; longer patterns stay plain text. */
const MAX_HIGHLIGHT_LENGTH = 1024;

/** Lexical styling only: never compile or execute the supplied expression. */
export function tokenizeGrepPattern(pattern: string): SynToken[] | null {
	if (pattern.length > MAX_HIGHLIGHT_LENGTH) return null;
	const tokens: SynToken[] = [];
	let start = 0;
	let previousRole: SynRole = "text";
	for (let index = 0; index < pattern.length;) {
		const char = pattern[index]!;
		let end = index + 1;
		let role: SynRole = "text";
		if (char === "\\") {
			end = Math.min(index + 2, pattern.length);
			role = "keyword";
		} else if (char === "[") {
			// An unfinished class retains its styling while the remaining call streams.
			while (end < pattern.length) {
				if (pattern[end] === "\\") end = Math.min(end + 2, pattern.length);
				else if (pattern[end++] === "]") break;
			}
			role = "string";
		} else if (char === "(" || char === ")") {
			if (char === "(" && pattern[end] === "?") {
				end++;
				if (pattern[end] === ":" || pattern[end] === "=" || pattern[end] === "!") end++;
				else if (pattern[end] === "<" && (pattern[end + 1] === "=" || pattern[end + 1] === "!")) end += 2;
			}
			role = "type";
		} else if (char === "*" || char === "+" || char === "?") {
			role = "number";
		} else if (char === "{") {
			while (end < pattern.length && pattern[end]! >= "0" && pattern[end]! <= "9") end++;
			if (end > index + 1) {
				if (pattern[end] === ",") {
					end++;
					while (end < pattern.length && pattern[end]! >= "0" && pattern[end]! <= "9") end++;
				}
				if (pattern[end] === "}") {
					end++;
					role = "number";
				} else end = index + 1;
			}
		} else if (char === "^" || char === "$" || char === "|" || char === ".") {
			role = "operator";
		}
		if (role !== previousRole) {
			if (index > start) tokens.push({ role: previousRole, text: pattern.slice(start, index) });
			start = index;
			previousRole = role;
		}
		index = end;
	}
	if (start < pattern.length) tokens.push({ role: previousRole, text: pattern.slice(start) });
	return tokens;
}

function Pattern({ args }: { args: Record<string, unknown> }): ReactNode {
	const pattern = str(args.pattern);
	if (pattern === null) return <InvalidArg what="pattern" />;
	const tokens = tokenizeGrepPattern(pattern);
	return <span className="tv-pattern">/{tokens === null ? pattern : tokens.map((token, index) => <span key={index} className={SYN_CLASS[token.role]}>{token.text}</span>)}/</span>;
}

function Summary({ args }: ToolRenderProps): ReactNode {
	return (
		<span>
			<Pattern args={args} /> <span className="tv-muted">in</span>{" "}
			{pathsOf(args).map((path, index) => <span key={path}>{index > 0 && ", "}<PathText path={path} kind={path === "." || /[\\/]$/.test(path) ? "folder" : undefined} /></span>)} <Badges items={argBadges(args)} />
		</span>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const matchCount = num(details?.matchCount);
	const fileCount = num(details?.fileCount);
	const truncated = details?.truncated === true;
	const error = str(details?.error);
	const text = resultTextOf(result);
	const noMatches = result !== undefined && !result.isError && error === null
		&& (matchCount === 0 || (matchCount === null && text.trim() === "No matches found"));
	// omp omits grouped file headers for a single searched file, including extensionless paths.
	const output = str(details?.displayContent) ?? text;
	const singleFileScope = fileCount === 1 && (Boolean(str(details?.scopePath)) || scopePaths(args).length === 1)
		&& !/^#+[ \t]+\S/m.test(output);
	const missing: string[] = [];
	if (details && Array.isArray(details.missingPaths)) {
		for (const p of details.missingPaths) {
			if (typeof p === "string") missing.push(shortenPath(p));
		}
	}
	const badges = argBadges(args);
	if (matchCount !== null && !noMatches) badges.push(`${matchCount} ${matchCount === 1 ? "match" : "matches"}`);
	if (fileCount !== null && !noMatches && !singleFileScope) badges.push(`${fileCount} ${fileCount === 1 ? "file" : "files"}`);
	return (
		<>
			<div>
				<Pattern args={args} /> <span className="tv-muted">in</span>{" "}
				{pathsOf(args).map((path, index) => <span key={path}>{index > 0 && ", "}<PathText path={path} kind={path === "." || /[\\/]$/.test(path) ? "folder" : undefined} /></span>)} <Badges items={badges} />
				{noMatches && <> <Badge tone="warn">0 matches</Badge></>}
				{truncated && (
					<>
						{" "}
						<Badge tone="warn">truncated</Badge>
					</>
				)}
			</div>
			{missing.length > 0 && <Note tone="warn">skipped missing: {missing.join(", ")}</Note>}
			{error !== null && !text.trim() && <Note tone="err">{error}</Note>}
			{!noMatches && <ResultText result={result} maxLines={14} variant="code" />}
		</>
	);
}

export const grepRenderer: ToolRenderer = { Summary, Body };
