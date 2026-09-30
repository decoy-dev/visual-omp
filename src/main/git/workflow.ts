import type { GitBranchCommit, GitPrContext, GitPrDraft } from "@shared/contracts/git-workflow";
import { runOmp } from "../omp/cli";
import { branches, headCommit, repoInfo, requireRepo, status } from "./repo";
import { failure, git, runGit } from "./run";

const MAX_BRANCH_COMMITS = 50;
/** Diff text sent to the model for a PR draft; keeps the prompt well under argv limits. */
const MAX_PROMPT_DIFF_CHARS = 40_000;
const PR_WRITE_TIMEOUT_MS = 5 * 60_000;

export async function switchBranch(cwd: string, branch: string): Promise<void> {
	const { root } = await requireRepo(cwd);
	const current = await status(root);
	const { staged, unstaged, conflicted } = current.totals;
	if (staged + unstaged + conflicted > 0) {
		throw new Error("You have unsaved changes. Commit them first (or work in a separate copy) before switching branches.");
	}
	const list = await branches(root);
	if (list.local.some(entry => entry.name === branch)) {
		await git(["switch", "--", branch], { cwd: root });
		return;
	}
	if (list.remote.some(entry => entry.name === branch)) {
		await git(["switch", "--track", branch], { cwd: root });
		return;
	}
	throw new Error(`There is no branch called "${branch}".`);
}

export async function createBranch(cwd: string, name: string): Promise<void> {
	const { root } = await requireRepo(cwd);
	const trimmed = name.trim();
	const check = await runGit(["check-ref-format", "--branch", trimmed], { cwd: root });
	if (!trimmed || check.code !== 0) throw new Error(`"${trimmed}" can't be used as a branch name. Use letters, numbers, - and /.`);
	await git(["switch", "-c", trimmed], { cwd: root });
}

export async function stageOnly(cwd: string, paths: string[]): Promise<void> {
	const { root } = await requireRepo(cwd);
	if (paths.length === 0) throw new Error("No files selected");
	if (await headCommit(root)) await git(["reset", "--quiet"], { cwd: root });
	else await git(["rm", "--cached", "-r", "--quiet", "--ignore-unmatch", "--", "."], { cwd: root });
	await git(["add", "--all", "--", ...paths], { cwd: root });
}

export async function prContext(cwd: string): Promise<GitPrContext> {
	const { root } = await requireRepo(cwd);
	const [info, list] = await Promise.all([repoInfo(root), branches(root)]);
	const remote = info.github?.remote ?? null;
	if (!remote) return { branch: list.current, remote: null, bases: [], defaultBase: null };
	const prefix = `${remote}/`;
	const bases = list.remote
		.filter(entry => entry.remote === remote)
		.map(entry => entry.name.slice(prefix.length))
		.filter(name => name && name !== list.current);
	const head = await runGit(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], { cwd: root });
	const fromHead = head.code === 0 ? head.stdout.trim().slice(prefix.length) : "";
	const defaultBase =
		[fromHead, "main", "master"].find(name => name && bases.includes(name)) ?? bases[0] ?? null;
	return { branch: list.current, remote, bases, defaultBase };
}

/** `<remote>/<base>` when that ref exists, else null (compare against nothing). */
async function baseRef(root: string, base: string | null): Promise<string | null> {
	if (!base) return null;
	const { remote } = await prContext(root);
	const ref = remote ? `${remote}/${base}` : base;
	const exists = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root });
	return exists.code === 0 ? ref : null;
}

/** Parses `git log --format=%H%x00%s%x00%b%x1e` output. */
export function parseBranchLog(raw: string): GitBranchCommit[] {
	return raw
		.split("\x1e")
		.map(record => record.replace(/^\n/, ""))
		.filter(record => record.trim())
		.map(record => {
			const [sha = "", subject = "", body = ""] = record.split("\0");
			return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
		});
}

export async function branchCommits(cwd: string, base: string | null): Promise<GitBranchCommit[]> {
	const { root } = await requireRepo(cwd);
	if (!(await headCommit(root))) return [];
	const ref = await baseRef(root, base);
	const range = ref ? `${ref}..HEAD` : "HEAD";
	const out = await git(
		["log", "--reverse", `--max-count=${MAX_BRANCH_COMMITS}`, "--format=%H%x00%s%x00%b%x1e", range],
		{ cwd: root },
	);
	return parseBranchLog(out);
}

/**
 * Reads the model's reply: the first non-empty line is the title (a leading `Title:` or `#` is
 * dropped), everything after it is the description. Code fences around the whole reply are removed.
 */
export function parsePrDraft(text: string): GitPrDraft {
	const lines = text
		.trim()
		.replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, "$1")
		.split("\n");
	const titleIndex = lines.findIndex(line => line.trim());
	if (titleIndex < 0) throw new Error("omp did not return a pull request description");
	const title = (lines[titleIndex] ?? "")
		.trim()
		.replace(/^#+\s*/, "")
		.replace(/^\*{0,2}title\*{0,2}\s*:\s*/i, "")
		.replace(/^\*\*(.*)\*\*$/, "$1")
		.trim();
	const body = lines
		.slice(titleIndex + 1)
		.join("\n")
		.replace(/^\s*\*{0,2}(description|body)\*{0,2}\s*:\s*\n?/i, "")
		.trim();
	return { title, body };
}

export async function prWrite(cwd: string, base: string | null): Promise<GitPrDraft> {
	const { root } = await requireRepo(cwd);
	const ref = await baseRef(root, base);
	const commits = await branchCommits(root, base);
	if (commits.length === 0) throw new Error("This branch has no commits to describe yet");
	const range = ref ? [`${ref}...HEAD`] : ["HEAD"];
	const stat = ref ? await git(["diff", "--stat", ...range], { cwd: root }) : "";
	const fullDiff = ref ? await git(["diff", "--no-color", ...range], { cwd: root }) : "";
	const diff =
		fullDiff.length > MAX_PROMPT_DIFF_CHARS ? `${fullDiff.slice(0, MAX_PROMPT_DIFF_CHARS)}\n… (diff truncated)` : fullDiff;
	const log = commits.map(entry => `- ${entry.subject}${entry.body ? `\n  ${entry.body.replace(/\n/g, "\n  ")}` : ""}`);
	const prompt = [
		"Write a GitHub pull request title and description for the changes below.",
		"Reply with ONLY: the title on the first line (under 72 characters, no prefix), a blank line, then a short Markdown description: what changed and why, and how to test it if obvious.",
		"",
		"Commits:",
		...log,
		...(stat ? ["", "Files changed:", stat.trim()] : []),
		...(diff ? ["", "Diff:", diff] : []),
	].join("\n");
	const result = await runOmp(
		["-p", "--no-session", "--no-tools", "--no-skills", "--no-rules", "--no-extensions", "--no-title", prompt],
		{ cwd: root, timeoutMs: PR_WRITE_TIMEOUT_MS },
	);
	if (result.code !== 0) throw failure("omp", result);
	return parsePrDraft(result.stdout);
}
