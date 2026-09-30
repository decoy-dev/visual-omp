/**
 * Pure parsers for git/gh/omp output. No I/O here so every transform is unit-testable against
 * captured fixture output.
 */
import type {
	GitBranch,
	GitChangeKind,
	GitClonePhase,
	GitConflictKind,
	GitDiffHunk,
	GitDiffLine,
	GitFileDiff,
	GitHubRepoRef,
	GitProposedCommit,
	GitRemote,
	GitSideChange,
	GitWorktree,
} from "@shared/contracts/git";

// ───────────────────────────────────────── status --porcelain=v2 -z

export interface StatusHeader {
	head: string | null;
	branch: string | null;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
}

export interface StatusEntry {
	path: string;
	origPath: string | null;
	kind: GitChangeKind;
	index: GitSideChange | null;
	worktree: GitSideChange | null;
	conflict: GitConflictKind | null;
	submodule: boolean;
}

export interface ParsedStatus extends StatusHeader {
	entries: StatusEntry[];
}

const SIDE: Record<string, GitSideChange | null> = {
	".": null,
	M: "modified",
	T: "typechange",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
};

const CONFLICTS: Record<string, GitConflictKind> = {
	DD: "both-deleted",
	AU: "added-by-us",
	UD: "deleted-by-them",
	UA: "added-by-them",
	DU: "deleted-by-us",
	AA: "both-added",
	UU: "both-modified",
};

/** Split the first `count` space-separated fields off `line`; the remainder (a path) may contain spaces. */
function fields(line: string, count: number): { parts: string[]; rest: string } {
	const parts: string[] = [];
	let start = 0;
	for (let i = 0; i < count; i++) {
		const end = line.indexOf(" ", start);
		if (end < 0) return { parts: [...parts, line.slice(start)], rest: "" };
		parts.push(line.slice(start, end));
		start = end + 1;
	}
	return { parts, rest: line.slice(start) };
}

function summarize(index: GitSideChange | null, worktree: GitSideChange | null): GitChangeKind {
	if (index === "renamed" || index === "copied") return index;
	if (worktree === "deleted" || index === "deleted") return "deleted";
	if (index === "added") return "added";
	if (index === "typechange" || worktree === "typechange") return "typechange";
	return "modified";
}

export function parseStatusV2(raw: string): ParsedStatus {
	const status: ParsedStatus = {
		head: null,
		branch: null,
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		entries: [],
	};
	const tokens = raw.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		if (token === "") continue;
		if (token.startsWith("# ")) {
			const { parts, rest } = fields(token, 2);
			const key = parts[1];
			if (key === "branch.oid") status.head = rest === "(initial)" ? null : rest;
			else if (key === "branch.head") {
				status.detached = rest === "(detached)";
				status.branch = status.detached ? null : rest;
			} else if (key === "branch.upstream") status.upstream = rest;
			else if (key === "branch.ab") {
				const match = /^\+(\d+) -(\d+)$/.exec(rest);
				if (match) {
					status.ahead = Number(match[1]);
					status.behind = Number(match[2]);
				}
			}
			continue;
		}
		const type = token[0];
		if (type === "?") {
			status.entries.push({
				path: token.slice(2),
				origPath: null,
				kind: "untracked",
				index: null,
				worktree: null,
				conflict: null,
				submodule: false,
			});
		} else if (type === "1" || type === "2") {
			const { parts, rest } = fields(token, type === "1" ? 8 : 9);
			const xy = parts[1] ?? "..";
			const index = SIDE[xy[0] ?? "."] ?? null;
			const worktree = SIDE[xy[1] ?? "."] ?? null;
			let origPath: string | null = null;
			if (type === "2") {
				origPath = tokens[i + 1] ?? null;
				i++;
			}
			status.entries.push({
				path: rest,
				origPath,
				kind: summarize(index, worktree),
				index,
				worktree,
				conflict: null,
				submodule: (parts[2] ?? "N").startsWith("S"),
			});
		} else if (type === "u") {
			const { parts, rest } = fields(token, 10);
			const xy = parts[1] ?? "UU";
			status.entries.push({
				path: rest,
				origPath: null,
				kind: "conflicted",
				index: null,
				worktree: null,
				conflict: CONFLICTS[xy] ?? "both-modified",
				submodule: (parts[2] ?? "N").startsWith("S"),
			});
		}
	}
	return status;
}

// ───────────────────────────────────────── diff --numstat -z

export interface NumstatEntry {
	path: string;
	origPath: string | null;
	additions: number | null;
	deletions: number | null;
	binary: boolean;
}

export function parseNumstat(raw: string): NumstatEntry[] {
	const tokens = raw.split("\0");
	const entries: NumstatEntry[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		if (token === "") continue;
		const first = token.indexOf("\t");
		const second = token.indexOf("\t", first + 1);
		if (first < 0 || second < 0) continue;
		const added = token.slice(0, first);
		const removed = token.slice(first + 1, second);
		let path = token.slice(second + 1);
		let origPath: string | null = null;
		if (path === "") {
			origPath = tokens[i + 1] ?? null;
			path = tokens[i + 2] ?? "";
			i += 2;
		}
		const binary = added === "-" && removed === "-";
		entries.push({
			path,
			origPath,
			additions: binary ? null : Number(added),
			deletions: binary ? null : Number(removed),
			binary,
		});
	}
	return entries;
}

// ───────────────────────────────────────── text content helpers

/** git's heuristic: a NUL byte within the first 8000 bytes means binary. */
export function isBinary(content: Uint8Array): boolean {
	const end = Math.min(content.length, 8000);
	for (let i = 0; i < end; i++) if (content[i] === 0) return true;
	return false;
}

/** Number of lines as git counts them for an added file. */
export function countLines(text: string): number {
	if (text === "") return 0;
	let lines = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
	return text.endsWith("\n") ? lines : lines + 1;
}

// ───────────────────────────────────────── unified diff

/** Decode a C-style quoted path as git prints it (`"a\tb"`, octal UTF-8 escapes). */
export function unquotePath(value: string): string {
	if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
	const body = value.slice(1, -1);
	const bytes: number[] = [];
	const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
	for (let i = 0; i < body.length; i++) {
		const ch = body[i] ?? "";
		if (ch !== "\\") {
			bytes.push(...Buffer.from(ch, "utf8"));
			continue;
		}
		const next = body[i + 1] ?? "";
		if (/[0-7]/.test(next)) {
			bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8));
			i += 3;
		} else {
			bytes.push(simple[next] ?? next.charCodeAt(0));
			i += 1;
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

/** Path from a `--- a/x` / `+++ b/x` line; null for /dev/null. git appends a tab when the name has spaces. */
function markerPath(value: string, prefix: string): string | null {
	const trimmed = value.endsWith("\t") ? value.slice(0, -1) : value;
	if (trimmed === "/dev/null") return null;
	const path = unquotePath(trimmed);
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Both sides of `diff --git a/X b/X`, when unambiguous (same path on both sides). */
function headerPath(rest: string): string | null {
	if (rest.startsWith('"')) {
		const match = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|\S.*)$/.exec(rest);
		return match?.[2] ? markerPath(match[2], "b/") : null;
	}
	if ((rest.length - 5) % 2 !== 0) return null;
	const len = (rest.length - 5) / 2;
	const a = rest.slice(2, 2 + len);
	const b = rest.slice(5 + len);
	return rest.startsWith("a/") && rest.slice(2 + len, 5 + len) === " b/" && a === b ? a : null;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Per-file patch size beyond which hunks are dropped (the UI shows "diff too large"). */
export const MAX_FILE_PATCH_BYTES = 1024 * 1024;

function parseFileChunk(chunk: string[]): GitFileDiff {
	let oldPath: string | null = null;
	let newPath: string | null = null;
	let renameFrom: string | null = null;
	let renameTo: string | null = null;
	let copy = false;
	let oldMode: string | null = null;
	let newMode: string | null = null;
	let created = false;
	let deleted = false;
	let binary = false;
	let bodyStart = chunk.length;
	const fallback = headerPath((chunk[0] ?? "").slice("diff --git ".length));
	for (let i = 1; i < chunk.length; i++) {
		const line = chunk[i] ?? "";
		if (line.startsWith("@@ ")) {
			bodyStart = i;
			break;
		}
		if (line.startsWith("--- ")) oldPath = markerPath(line.slice(4), "a/");
		else if (line.startsWith("+++ ")) newPath = markerPath(line.slice(4), "b/");
		else if (line.startsWith("rename from ")) renameFrom = unquotePath(line.slice(12));
		else if (line.startsWith("rename to ")) renameTo = unquotePath(line.slice(10));
		else if (line.startsWith("copy from ")) {
			renameFrom = unquotePath(line.slice(10));
			copy = true;
		} else if (line.startsWith("copy to ")) renameTo = unquotePath(line.slice(8));
		else if (line.startsWith("new file mode ")) {
			created = true;
			newMode = line.slice(14);
		} else if (line.startsWith("deleted file mode ")) {
			deleted = true;
			oldMode = line.slice(18);
		} else if (line.startsWith("old mode ")) oldMode = line.slice(9);
		else if (line.startsWith("new mode ")) newMode = line.slice(9);
		else if (line.startsWith("index ")) {
			const mode = /^index \S+ (\d+)$/.exec(line)?.[1];
			if (mode) {
				oldMode ??= mode;
				newMode ??= mode;
			}
		} else if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
	}
	const path = renameTo ?? newPath ?? oldPath ?? fallback ?? "";
	const origPath = renameFrom && renameFrom !== path ? renameFrom : null;
	const typeChange = oldMode !== null && newMode !== null && oldMode.slice(0, 2) !== newMode.slice(0, 2);
	const kind: GitFileDiff["kind"] = created
		? "added"
		: deleted
			? "deleted"
			: origPath
				? copy
					? "copied"
					: "renamed"
				: typeChange
					? "typechange"
					: "modified";

	const patch = `${chunk.join("\n")}\n`;
	const truncated = patch.length > MAX_FILE_PATCH_BYTES;
	const hunks: GitDiffHunk[] = [];
	let additions = 0;
	let deletions = 0;
	let hunk: GitDiffHunk | null = null;
	let oldLine = 0;
	let newLine = 0;
	for (let i = bodyStart; i < chunk.length; i++) {
		const line = chunk[i] ?? "";
		const header = HUNK_RE.exec(line);
		if (header) {
			oldLine = Number(header[1]);
			newLine = Number(header[3]);
			hunk = {
				header: line,
				oldStart: oldLine,
				oldLines: header[2] === undefined ? 1 : Number(header[2]),
				newStart: newLine,
				newLines: header[4] === undefined ? 1 : Number(header[4]),
				section: header[5] ?? "",
				lines: [],
			};
			if (!truncated) hunks.push(hunk);
			continue;
		}
		if (!hunk) continue;
		const marker = line[0];
		let entry: GitDiffLine | null = null;
		if (marker === "+") {
			additions++;
			entry = { kind: "add", text: line.slice(1), oldLine: null, newLine: newLine++, noNewline: false };
		} else if (marker === "-") {
			deletions++;
			entry = { kind: "del", text: line.slice(1), oldLine: oldLine++, newLine: null, noNewline: false };
		} else if (marker === " ") {
			entry = { kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++, noNewline: false };
		} else if (marker === "\\") {
			const last = hunk.lines.at(-1);
			if (last) last.noNewline = true;
		}
		if (entry && !truncated) hunk.lines.push(entry);
	}
	return {
		path,
		origPath,
		kind,
		untracked: false,
		binary,
		oldMode: created ? null : oldMode,
		newMode: deleted ? null : newMode,
		additions,
		deletions,
		hunks,
		patch: truncated ? `${chunk.slice(0, bodyStart).join("\n")}\n` : patch,
		truncated,
	};
}

/**
 * Split `git diff` output into per-file diffs with parsed hunks. git prints a type change (file ↔
 * symlink) as a deletion followed by an addition of the same path; those pairs become one
 * `typechange` entry.
 */
export function parseUnifiedDiff(text: string): GitFileDiff[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	const chunks: string[][] = [];
	for (const line of lines) {
		if (line.startsWith("diff --git ")) chunks.push([line]);
		else chunks.at(-1)?.push(line);
	}
	const files: GitFileDiff[] = [];
	for (const chunk of chunks) {
		const file = parseFileChunk(chunk);
		const previous = files.at(-1);
		if (previous?.kind === "deleted" && file.kind === "added" && previous.path === file.path) {
			files[files.length - 1] = {
				...file,
				kind: "typechange",
				binary: previous.binary || file.binary,
				oldMode: previous.oldMode,
				additions: previous.additions + file.additions,
				deletions: previous.deletions + file.deletions,
				hunks: [...previous.hunks, ...file.hunks],
				patch: previous.patch + file.patch,
				truncated: previous.truncated || file.truncated,
			};
		} else files.push(file);
	}
	return files;
}

/**
 * Build the diff git would print for an untracked file (`git diff --no-index /dev/null <path>`).
 * `content` is null for binary files; `truncated` when the file was too large to read.
 */
export function syntheticAddedDiff(
	path: string,
	mode: string,
	content: string | null,
	truncated = false,
): GitFileDiff {
	const header = [`diff --git a/${path} b/${path}`, `new file mode ${mode}`];
	const base = {
		path,
		origPath: null,
		kind: "added" as const,
		untracked: true,
		oldMode: null,
		newMode: mode,
		deletions: 0,
	};
	if (content === null || truncated) {
		const lines = content === null ? [...header, `Binary files /dev/null and b/${path} differ`] : header;
		return {
			...base,
			binary: content === null,
			additions: 0,
			hunks: [],
			patch: `${lines.join("\n")}\n`,
			truncated,
		};
	}
	const body = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
	if (content === "") body.length = 0;
	const noNewline = content !== "" && !content.endsWith("\n");
	const lines: GitDiffLine[] = body.map((text, i) => ({
		kind: "add",
		text,
		oldLine: null,
		newLine: i + 1,
		noNewline: noNewline && i === body.length - 1,
	}));
	const hunkHeader = `@@ -0,0 +1${body.length === 1 ? "" : `,${body.length}`} @@`;
	const patchLines =
		body.length === 0
			? header
			: [
					...header,
					"--- /dev/null",
					`+++ b/${path}`,
					hunkHeader,
					...body.map(line => `+${line}`),
					...(noNewline ? ["\\ No newline at end of file"] : []),
				];
	const patch = `${patchLines.join("\n")}\n`;
	const tooLarge = patch.length > MAX_FILE_PATCH_BYTES;
	return {
		...base,
		binary: false,
		additions: body.length,
		hunks:
			body.length === 0 || tooLarge
				? []
				: [
						{
							header: hunkHeader,
							oldStart: 0,
							oldLines: 0,
							newStart: 1,
							newLines: body.length,
							section: "",
							lines,
						},
					],
		patch: tooLarge ? `${header.join("\n")}\n` : patch,
		truncated: tooLarge,
	};
}

// ───────────────────────────────────────── worktree list --porcelain -z

export function parseWorktrees(raw: string, currentRoot: string | null): GitWorktree[] {
	const worktrees: GitWorktree[] = [];
	let current: GitWorktree | null = null;
	for (const token of raw.split("\0")) {
		if (token === "") {
			current = null;
			continue;
		}
		const space = token.indexOf(" ");
		const key = space < 0 ? token : token.slice(0, space);
		const value = space < 0 ? null : token.slice(space + 1);
		if (key === "worktree") {
			current = {
				path: value ?? "",
				head: null,
				branch: null,
				detached: false,
				bare: false,
				locked: false,
				lockReason: null,
				prunable: false,
				pruneReason: null,
				isMain: worktrees.length === 0,
				isCurrent: false,
			};
			worktrees.push(current);
			continue;
		}
		if (!current) continue;
		if (key === "HEAD") current.head = value;
		else if (key === "branch") current.branch = value?.replace(/^refs\/heads\//, "") ?? null;
		else if (key === "detached") current.detached = true;
		else if (key === "bare") current.bare = true;
		else if (key === "locked") {
			current.locked = true;
			current.lockReason = value;
		} else if (key === "prunable") {
			current.prunable = true;
			current.pruneReason = value;
		}
	}
	if (currentRoot) {
		const normalized = stripPrivate(currentRoot);
		for (const worktree of worktrees) worktree.isCurrent = stripPrivate(worktree.path) === normalized;
	}
	return worktrees;
}

/** macOS reports /tmp paths as /private/tmp in some places and not others. */
function stripPrivate(path: string): string {
	return path.replace(/^\/private(?=\/(?:tmp|var|etc)\/)/, "").replace(/\/+$/, "");
}

// ───────────────────────────────────────── for-each-ref

/** `git for-each-ref` format producing the fields {@link parseRefs} reads (NUL-separated, NUL-terminated). */
export const REF_FORMAT = [
	"%(refname)",
	"%(objectname)",
	"%(upstream:short)",
	"%(upstream:track,nobracket)",
	"%(HEAD)",
	"%(committerdate:unix)",
	"%(subject)",
	"%(worktreepath)",
	"",
].join("%00");

export function parseRefs(raw: string): { local: GitBranch[]; remote: GitBranch[] } {
	const local: GitBranch[] = [];
	const remote: GitBranch[] = [];
	for (const line of raw.split("\n")) {
		if (line === "") continue;
		const [ref = "", commit = "", upstream = "", track = "", head = "", date = "0", subject = "", worktree = ""] =
			line.split("\0");
		const isRemote = ref.startsWith("refs/remotes/");
		const name = ref.replace(/^refs\/(heads|remotes)\//, "");
		if (isRemote && name.endsWith("/HEAD")) continue;
		const ahead = /ahead (\d+)/.exec(track);
		const behind = /behind (\d+)/.exec(track);
		const branch: GitBranch = {
			name,
			ref,
			remote: isRemote ? (name.split("/")[0] ?? null) : null,
			commit,
			subject,
			date: Number(date) * 1000,
			upstream: upstream || null,
			upstreamGone: track === "gone",
			ahead: ahead ? Number(ahead[1]) : 0,
			behind: behind ? Number(behind[1]) : 0,
			current: head === "*",
			worktreePath: worktree || null,
		};
		(isRemote ? remote : local).push(branch);
	}
	return { local, remote };
}

// ───────────────────────────────────────── remotes / GitHub

export function parseRemotes(raw: string): GitRemote[] {
	const remotes: GitRemote[] = [];
	for (const line of raw.split("\n")) {
		const match = /^(\S+)\t(.+) \(fetch\)$/.exec(line);
		if (match?.[1] && match[2]) remotes.push({ name: match[1], url: match[2] });
	}
	return remotes;
}

/** owner/repo of a GitHub remote URL (https, ssh://, scp-style `git@host:owner/repo`), else null. */
export function parseGitHubUrl(url: string): Omit<GitHubRepoRef, "remote"> | null {
	const match =
		/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
		/^(?:[^@/]+@)?([^/:]+):\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
	if (!match?.[1] || !match[2] || !match[3]) return null;
	let host = match[1].toLowerCase();
	if (!host.includes("github")) return null;
	if (host === "ssh.github.com" || host === "www.github.com") host = "github.com";
	return { host, owner: match[2], repo: match[3], webUrl: `https://${host}/${match[2]}/${match[3]}` };
}

export function pickGitHubRemote(remotes: GitRemote[]): GitHubRepoRef | null {
	const preference = ["origin", "upstream"];
	const ranked = remotes.map(remote => {
		const index = preference.indexOf(remote.name);
		return { remote, rank: index < 0 ? preference.length : index };
	});
	const order = ranked.sort((a, b) => a.rank - b.rank).map(entry => entry.remote);
	for (const remote of order) {
		const ref = parseGitHubUrl(remote.url);
		if (ref) return { remote: remote.name, ...ref };
	}
	return null;
}

/** Folder name `git clone` would pick for a URL. */
export function repoNameFromUrl(url: string): string {
	const trimmed = url.trim().replace(/[/\\]+$/, "").replace(/\.git$/, "").replace(/[/\\]+$/, "");
	const name = trimmed.split(/[/\\:]/).at(-1) ?? "";
	return name || "repository";
}

// ───────────────────────────────────────── clone --progress

const CLONE_PHASES: Array<[RegExp, GitClonePhase, number, number]> = [
	[/^(?:remote: )?Enumerating objects/, "enumerating", 0, 2],
	[/^(?:remote: )?Counting objects/, "counting", 2, 6],
	[/^(?:remote: )?Compressing objects/, "compressing", 6, 10],
	[/^Receiving objects/, "receiving", 10, 80],
	[/^Resolving deltas/, "resolving", 80, 95],
	[/^(?:Updating files|Checking out files|Filtering content)/, "checkout", 95, 100],
];

export interface CloneProgressLine {
	phase: GitClonePhase;
	percent: number | null;
	/** Overall 0–100 estimate for this line alone (callers keep it monotonic). */
	overall: number;
	message: string;
}

/** Interpret one `\r`/`\n`-delimited progress line from `git clone --progress` stderr. */
export function parseCloneProgress(line: string): CloneProgressLine | null {
	const message = line.trim();
	for (const [re, phase, from, to] of CLONE_PHASES) {
		if (!re.test(message)) continue;
		const pct = /:\s+(\d{1,3})%/.exec(message);
		const percent = pct ? Number(pct[1]) : null;
		const overall = Math.round(from + ((to - from) * (percent ?? (/done\.?$/.test(message) ? 100 : 0))) / 100);
		return { phase, percent, overall, message: message.replace(/^remote: /, "") };
	}
	return null;
}

// ───────────────────────────────────────── omp commit output

export interface CommitOutput {
	commits: GitProposedCommit[];
	warnings: string[];
	usedFallback: boolean;
	noChanges: boolean;
}

/** Interpret `omp commit [--dry-run]` stdout/stderr (the command has no machine-readable mode). */
export function parseCommitOutput(stdout: string, stderr: string): CommitOutput {
	stdout = stdout.replace(/\r\n/g, "\n");
	stderr = stderr.replace(/\r\n/g, "\n");
	const warnings: string[] = [];
	const lines = stdout.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] !== "Warnings:") continue;
		for (let j = i + 1; j < lines.length && (lines[j] ?? "").startsWith("- "); j++) {
			warnings.push((lines[j] ?? "").slice(2));
		}
	}
	const usedFallback = /^● (?:Using|Forcing) fallback commit generation|^● Agent did not provide proposal, using fallback/m.test(
		stdout,
	);
	const noChanges = /^No changes to commit\.$/m.test(stderr) || /^No changes to commit\.$/m.test(stdout);
	const commits: GitProposedCommit[] = [];
	const single = stdout.indexOf("\nGenerated commit message:\n");
	const split = stdout.indexOf("\nSplit commit plan (dry run):\n");
	if (single >= 0) {
		const message = stdout.slice(single + "\nGenerated commit message:\n".length).trimEnd();
		if (message) commits.push({ message, changes: null });
	} else if (split >= 0) {
		const body = stdout.slice(split + "\nSplit commit plan (dry run):\n".length);
		for (const block of body.split(/^Commit \d+:\n/m).slice(1)) {
			const changesAt = block.lastIndexOf("\nChanges: ");
			const message = (changesAt >= 0 ? block.slice(0, changesAt) : block).trimEnd();
			const changes = changesAt >= 0 ? block.slice(changesAt + "\nChanges: ".length).split("\n")[0] ?? null : null;
			commits.push({ message, changes });
		}
	}
	return { commits, warnings, usedFallback, noChanges };
}
