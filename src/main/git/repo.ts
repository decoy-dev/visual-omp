import { lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
	GitBranches,
	GitCommitResult,
	GitDiff,
	GitDiffOptions,
	GitFileDiff,
	GitFileStatus,
	GitManualCommitOptions,
	GitOperation,
	GitPushResult,
	GitRepoInfo,
	GitStatus,
	GitWorktree,
	GitWorktreeAddOptions,
	GitWorktreeAddResult,
} from "@shared/contracts/git";
import { pathExists } from "../files";
import { runOmp } from "../omp/cli";
import {
	countLines,
	isBinary,
	parseNumstat,
	parseRefs,
	parseRemotes,
	parseStatusV2,
	parseUnifiedDiff,
	parseWorktrees,
	pickGitHubRemote,
	REF_FORMAT,
	syntheticAddedDiff,
	type NumstatEntry,
} from "./parse";
import { failure, git, runGit } from "./run";

/** Untracked files larger than this are not read for line counts / diffs. */
const MAX_UNTRACKED_READ_BYTES = 8 * 1024 * 1024;
/** Cap on untracked files read per status/diff so a huge unignored build dir stays responsive. */
const MAX_UNTRACKED_FILES = 2000;
const READ_CONCURRENCY = 32;

const STATUS_ARGS = ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--find-renames"];
const DIFF_FLAGS = ["-M", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
/**
 * Work tree vs `base`. Plumbing `diff-index` instead of porcelain `git diff`: the porcelain
 * refreshes and rewrites `.git/index` (ignoring GIT_OPTIONAL_LOCKS), which would retrigger the
 * repo watcher on every status poll. Output is identical.
 */
const worktreeDiff = (base: string, ...args: string[]) => ["diff-index", base, ...DIFF_FLAGS, ...args];

interface RepoPaths {
	root: string;
	gitDir: string;
	commonDir: string;
}

/** Work-tree root and git dirs for `cwd`; null when `cwd` is not inside a work tree. */
export async function repoPaths(cwd: string): Promise<RepoPaths | null> {
	const result = await runGit(
		["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
		{ cwd },
	);
	if (result.code !== 0) return null;
	const [root, gitDir, commonDir] = result.stdout.split("\n");
	return root && gitDir && commonDir ? { root, gitDir, commonDir } : null;
}

export async function requireRepo(cwd: string): Promise<RepoPaths> {
	const paths = await repoPaths(cwd);
	if (!paths) throw new Error(`Not a git repository: ${cwd}`);
	return paths;
}

export async function headCommit(root: string): Promise<string | null> {
	const result = await runGit(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: root });
	return result.code === 0 ? result.stdout.trim() : null;
}

/** HEAD, or the empty tree on an unborn branch (hash depends on the repo's object format). */
async function diffBase(root: string, head: string | null): Promise<string> {
	if (head) return "HEAD";
	return (await git(["hash-object", "-t", "tree", "--stdin"], { cwd: root, input: "" })).trim();
}

export async function repoInfo(cwd: string): Promise<GitRepoInfo> {
	const paths = (await pathExists(cwd)) ? await repoPaths(cwd) : null;
	if (!paths) {
		return {
			isRepo: false,
			root: null,
			gitDir: null,
			commonDir: null,
			isLinkedWorktree: false,
			hasCommits: false,
			remotes: [],
			hasRemote: false,
			github: null,
		};
	}
	const [head, remotesRaw] = await Promise.all([
		headCommit(paths.root),
		git(["remote", "-v"], { cwd: paths.root }),
	]);
	const remotes = parseRemotes(remotesRaw);
	return {
		isRepo: true,
		...paths,
		isLinkedWorktree: paths.gitDir !== paths.commonDir,
		hasCommits: head !== null,
		remotes,
		hasRemote: remotes.length > 0,
		github: pickGitHubRemote(remotes),
	};
}

async function operationInProgress(gitDir: string): Promise<GitOperation | null> {
	const markers: Array<[string, GitOperation]> = [
		["rebase-merge", "rebase"],
		["rebase-apply", "rebase"],
		["MERGE_HEAD", "merge"],
		["CHERRY_PICK_HEAD", "cherry-pick"],
		["REVERT_HEAD", "revert"],
		["BISECT_LOG", "bisect"],
	];
	const present = await Promise.all(markers.map(([file]) => pathExists(join(gitDir, file))));
	return markers[present.indexOf(true)]?.[1] ?? null;
}

/** Map over `items` with at most `limit` promises in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index] as T, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

interface UntrackedContent {
	mode: string;
	/** null for binary files and directories (nested repositories). */
	text: string | null;
	/** Not read (too large, a directory, or past the file cap). */
	skipped: boolean;
}

async function readUntracked(root: string, path: string): Promise<UntrackedContent> {
	const full = join(root, path);
	const stat = await lstat(full).catch(() => null);
	if (!stat || stat.isDirectory()) return { mode: "160000", text: null, skipped: true };
	if (stat.isSymbolicLink()) return { mode: "120000", text: await readlink(full), skipped: false };
	const mode = stat.mode & 0o111 ? "100755" : "100644";
	if (stat.size > MAX_UNTRACKED_READ_BYTES) return { mode, text: null, skipped: true };
	const bytes = await readFile(full);
	return { mode, text: isBinary(bytes) ? null : bytes.toString("utf8"), skipped: false };
}

export async function status(cwd: string): Promise<GitStatus> {
	const { root, gitDir } = await requireRepo(cwd);
	const [raw, operation] = await Promise.all([git(STATUS_ARGS, { cwd: root }), operationInProgress(gitDir)]);
	const parsed = parseStatusV2(raw);
	const base = await diffBase(root, parsed.head);
	const numstat = parseNumstat(await git(worktreeDiff(base, "--numstat", "-z"), { cwd: root }));
	const counts = new Map<string, NumstatEntry>(numstat.map(entry => [entry.path, entry]));

	const untracked = parsed.entries.filter(entry => entry.kind === "untracked").slice(0, MAX_UNTRACKED_FILES);
	const untrackedCounts = new Map<string, { lines: number | null; binary: boolean }>();
	await mapLimit(untracked, READ_CONCURRENCY, async entry => {
		const content = await readUntracked(root, entry.path).catch(() => null);
		if (!content || content.skipped) return;
		untrackedCounts.set(entry.path, {
			lines: content.text === null ? null : countLines(content.text),
			binary: content.text === null,
		});
	});

	const files: GitFileStatus[] = parsed.entries.map(entry => {
		const numbers = counts.get(entry.path);
		const extra = untrackedCounts.get(entry.path);
		return {
			...entry,
			additions: numbers ? numbers.additions : (extra?.lines ?? null),
			deletions: numbers ? numbers.deletions : extra && !extra.binary ? 0 : null,
			binary: numbers?.binary ?? extra?.binary ?? false,
		};
	});
	return {
		root,
		branch: parsed.branch,
		head: parsed.head,
		detached: parsed.detached,
		unborn: parsed.head === null,
		upstream: parsed.upstream,
		ahead: parsed.ahead,
		behind: parsed.behind,
		operation,
		files,
		totals: totalsOf(files),
	};
}

function totalsOf(files: GitFileStatus[]): GitStatus["totals"] {
	const totals = { files: files.length, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, additions: 0, deletions: 0 };
	for (const file of files) {
		if (file.index) totals.staged++;
		if (file.worktree) totals.unstaged++;
		if (file.kind === "untracked") totals.untracked++;
		if (file.kind === "conflicted") totals.conflicted++;
		totals.additions += file.additions ?? 0;
		totals.deletions += file.deletions ?? 0;
	}
	return totals;
}

export async function diff(cwd: string, options: GitDiffOptions = {}): Promise<GitDiff> {
	const { root } = await requireRepo(cwd);
	const head = await headCommit(root);
	const base = await diffBase(root, head);
	const flags = [`-U${options.context ?? 3}`, ...(options.ignoreWhitespace ? ["-w"] : [])];
	const wanted = options.paths ? new Set(options.paths) : null;

	let pathspec: string[] = [];
	if (wanted) {
		// Pair renames: a pathspec naming only one side would show a delete or an add instead.
		const renames = parseNumstat(await git(worktreeDiff(base, "--numstat", "-z"), { cwd: root }));
		const expanded = new Set(wanted);
		for (const entry of renames) {
			if (entry.origPath && (wanted.has(entry.path) || wanted.has(entry.origPath))) {
				expanded.add(entry.path);
				expanded.add(entry.origPath);
			}
		}
		pathspec = [...expanded];
	}
	const tracked = parseUnifiedDiff(await git(worktreeDiff(base, "-p", ...flags, "--", ...pathspec), { cwd: root })).filter(
		file => !wanted || wanted.has(file.path) || (file.origPath !== null && wanted.has(file.origPath)),
	);

	let untracked: GitFileDiff[] = [];
	if (options.untracked !== false) {
		const listed = await git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...pathspec], { cwd: root });
		const paths = listed.split("\0").filter(path => path !== "" && (!wanted || wanted.has(path)));
		untracked = await mapLimit(paths, READ_CONCURRENCY, async (path, index) => {
			const content = index < MAX_UNTRACKED_FILES ? await readUntracked(root, path).catch(() => null) : null;
			return content
				? syntheticAddedDiff(path, content.mode, content.text, content.skipped)
				: syntheticAddedDiff(path, "100644", "", true);
		});
	}
	const files = [...tracked, ...untracked].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { root, base: head ? "HEAD" : "empty", files };
}

/**
 * Drop every staged and unstaged change to `paths`, restoring HEAD. Paths that do not exist in HEAD
 * (untracked, newly added, rename targets) are removed from the index and handed to `trash`.
 */
export async function discard(cwd: string, paths: string[], trash: (absPath: string) => Promise<void>): Promise<void> {
	if (paths.length === 0) return;
	const { root } = await requireRepo(cwd);
	const parsed = parseStatusV2(await git(STATUS_ARGS, { cwd: root }));
	const wanted = new Set(paths);
	const candidates = new Set<string>();
	for (const entry of parsed.entries) {
		if (!wanted.has(entry.path) && !(entry.origPath && wanted.has(entry.origPath))) continue;
		candidates.add(entry.path);
		// Undoing a rename brings the source back; a copy's source was never changed.
		if (entry.origPath && entry.kind === "renamed") candidates.add(entry.origPath);
	}
	if (candidates.size === 0) return;
	const list = [...candidates];
	const inHead = new Set<string>();
	if (parsed.head) {
		const tree = await git(["ls-tree", "-z", "--name-only", "HEAD", "--", ...list], { cwd: root });
		for (const path of tree.split("\0")) if (path) inHead.add(path);
	}
	const restore = list.filter(path => inHead.has(path));
	const remove = list.filter(path => !inHead.has(path));
	if (restore.length > 0) {
		await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...restore], { cwd: root });
	}
	if (remove.length > 0) {
		await git(["rm", "--cached", "--force", "--quiet", "--ignore-unmatch", "-r", "--", ...remove], { cwd: root });
		for (const path of remove) {
			const full = join(root, path);
			if (await pathExists(full)) await trash(full);
		}
	}
}

export async function init(dir: string, options: { initialBranch?: string } = {}): Promise<GitRepoInfo> {
	await mkdir(dir, { recursive: true });
	await git(["init", ...(options.initialBranch ? [`--initial-branch=${options.initialBranch}`] : []), "--", dir], {
		cwd: dir,
	});
	return repoInfo(dir);
}

export async function branches(cwd: string): Promise<GitBranches> {
	const { root } = await requireRepo(cwd);
	const [refs, symbolic, head] = await Promise.all([
		git(["for-each-ref", "--sort=-committerdate", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes"], {
			cwd: root,
		}),
		runGit(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: root }),
		headCommit(root),
	]);
	const current = symbolic.code === 0 ? symbolic.stdout.trim() : null;
	return { current, detached: current === null, head, ...parseRefs(refs) };
}

export async function worktrees(cwd: string): Promise<GitWorktree[]> {
	const { root } = await requireRepo(cwd);
	return parseWorktrees(await git(["worktree", "list", "--porcelain", "-z"], { cwd: root }), root);
}

/** Create a worktree with `omp worktree add` (copy-on-write clone of the checkout when supported). */
export async function worktreeAdd(cwd: string, options: GitWorktreeAddOptions): Promise<GitWorktreeAddResult> {
	const { root } = await requireRepo(cwd);
	const target = isAbsolute(options.path) ? options.path : resolve(root, options.path);
	const argv = ["worktree", "add", "--cwd", root];
	if (options.branch) argv.push("--branch", options.branch);
	if (options.detach) argv.push("--detach");
	argv.push(target);
	if (options.base) argv.push(options.base);
	const result = await runOmp(argv, { cwd: root, timeoutMs: 10 * 60_000 });
	if (result.code !== 0) throw failure("omp worktree add", result);
	const real = await realpath(target);
	const list = await worktrees(root);
	const matches = await Promise.all(list.map(entry => realpath(entry.path).then(path => path === real, () => false)));
	const worktree = list[matches.indexOf(true)];
	if (!worktree) throw new Error(`omp created ${target} but git does not list it as a worktree`);
	return { worktree, log: `${result.stdout}${result.stderr}`.trim() };
}

export async function worktreeRemove(cwd: string, path: string, force = false): Promise<void> {
	const { root } = await requireRepo(cwd);
	await git(["worktree", "remove", ...(force ? ["--force"] : []), "--", path], { cwd: root });
}

/** Commits in `from..HEAD` (all of HEAD's history when `from` is null), oldest first. */
export async function commitsSince(root: string, from: string | null): Promise<GitCommitResult["commits"]> {
	const head = await headCommit(root);
	if (!head || head === from) return [];
	const out = await git(["log", "--reverse", "--format=%H%x00%s", from ? `${from}..HEAD` : "HEAD"], { cwd: root });
	return out
		.split("\n")
		.filter(Boolean)
		.map(line => {
			const [sha = "", subject = ""] = line.split("\0");
			return { sha, subject };
		});
}

/** `git commit` with a user-written message. */
export async function commit(cwd: string, options: GitManualCommitOptions): Promise<GitCommitResult> {
	const { root } = await requireRepo(cwd);
	if (!options.message.trim()) throw new Error("Commit message is empty");
	const stage = options.stage ?? "all";
	const log: string[] = [];
	if (stage === "all") await git(["add", "--all"], { cwd: root });
	else if (Array.isArray(stage)) {
		if (stage.length === 0) throw new Error("No files selected to commit");
		await git(["add", "--all", "--", ...stage], { cwd: root });
	}
	const args = ["commit", "--file=-", ...(options.amend ? ["--amend"] : [])];
	if (Array.isArray(stage)) args.push("--only", "--", ...stage);
	const result = await runGit(args, { cwd: root, input: options.message });
	log.push(result.stdout, result.stderr);
	if (result.code !== 0) throw failure("git commit", result);
	const latest = (await git(["log", "-1", "--format=%H%x00%s"], { cwd: root })).trim().split("\0");
	let pushed = false;
	if (options.push) {
		const push = await pushBranch(root);
		log.push(push.log);
		pushed = true;
	}
	return {
		commits: [{ sha: latest[0] ?? "", subject: latest[1] ?? "" }],
		pushed,
		usedFallback: false,
		warnings: [],
		log: log.join("").trim(),
	};
}

/** Push the current branch; the first push sets the upstream on the branch's push remote. */
export async function pushBranch(cwd: string): Promise<GitPushResult> {
	const { root } = await requireRepo(cwd);
	const symbolic = await runGit(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: root });
	if (symbolic.code !== 0) throw new Error("Cannot push: HEAD is detached. Create a branch first.");
	const branch = symbolic.stdout.trim();
	const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: root });
	if (upstream.code === 0) {
		const result = await runGit(["push"], { cwd: root, timeoutMs: 10 * 60_000 });
		if (result.code !== 0) throw failure("git push", result);
		const remote = (await git(["config", "--get", `branch.${branch}.remote`], { cwd: root })).trim();
		return { remote, branch, setUpstream: false, log: `${result.stdout}${result.stderr}`.trim() };
	}
	const remotes = parseRemotes(await git(["remote", "-v"], { cwd: root })).map(entry => entry.name);
	if (remotes.length === 0) throw new Error("Cannot push: this repository has no remote.");
	const configured = await runGit(["config", "--get", `branch.${branch}.pushRemote`], { cwd: root });
	const pushDefault = await runGit(["config", "--get", "remote.pushDefault"], { cwd: root });
	const remote =
		[configured.stdout.trim(), pushDefault.stdout.trim(), "origin"].find(name => name && remotes.includes(name)) ??
		remotes[0] ??
		"origin";
	const result = await runGit(["push", "--set-upstream", remote, `HEAD:refs/heads/${branch}`], {
		cwd: root,
		timeoutMs: 10 * 60_000,
	});
	if (result.code !== 0) throw failure("git push", result);
	return { remote, branch, setUpstream: true, log: `${result.stdout}${result.stderr}`.trim() };
}

/** Files staged vs HEAD (or vs the empty tree on an unborn branch). */
export async function hasStagedChanges(root: string): Promise<boolean> {
	const result = await runGit(["diff", "--cached", "--quiet"], { cwd: root });
	return result.code === 1;
}

/** Return the index to "nothing staged" (used after `omp commit --dry-run` auto-staged everything). */
export async function unstageAll(root: string): Promise<void> {
	if (await headCommit(root)) await git(["reset", "--quiet"], { cwd: root });
	else await git(["rm", "--cached", "-r", "--quiet", "--ignore-unmatch", "--", "."], { cwd: root });
}

