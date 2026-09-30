import type { GhPullRequest } from "@shared/contracts/git";
import type { GitBranchCommit } from "@shared/contracts/git-workflow";

export const shortSha = (sha: string) => sha.slice(0, 7);

export type CiState = "pass" | "pending" | "fail" | "none";

/** One badge state for a PR's checks: any failure wins, then anything still running. */
export function ciState(pr: GhPullRequest): CiState {
	const { total, failing, pending } = pr.checksSummary;
	if (total === 0) return "none";
	if (failing > 0) return "fail";
	if (pending > 0) return "pending";
	return "pass";
}

/** "fix/checkout-total" → "Checkout total" (the last path segment, in words). */
export function humanizeBranch(branch: string): string {
	const words = (branch.split("/").pop() ?? branch).replace(/[-_]+/g, " ").trim();
	return words ? words[0].toUpperCase() + words.slice(1) : branch;
}

/**
 * PR fields from the branch's commits, like `gh pr create --fill`: one commit gives its subject and
 * body; several give the branch name as the title and the subjects as a list.
 */
export function prefillPr(branch: string | null, commits: readonly GitBranchCommit[]): { title: string; body: string } {
	const [only] = commits;
	if (commits.length === 1 && only) return { title: only.subject, body: only.body };
	const title = branch ? humanizeBranch(branch) : (commits.at(-1)?.subject ?? "");
	return { title, body: commits.map(commit => `- ${commit.subject}`).join("\n") };
}

/** Parent folder of an absolute path (either separator), without a trailing separator. */
function parentDir(path: string): { parent: string; name: string; sep: string } {
	const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
	const trimmed = path.replace(/[\\/]+$/, "");
	const cut = trimmed.lastIndexOf(sep);
	return { parent: cut > 0 ? trimmed.slice(0, cut) : sep, name: trimmed.slice(cut + 1), sep };
}

/**
 * Where a "separate copy" of `root` goes: a `<repo>-copies` folder next to the project, one folder
 * per copy named after the time it was made. omp names the new branch after that folder.
 */
export function worktreeLocation(root: string, now: Date): { path: string; name: string } {
	const { parent, name: repo, sep } = parentDir(root);
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const name = `copy-${stamp}`;
	const base = parent.endsWith(sep) ? parent : `${parent}${sep}`;
	return { path: `${base}${repo}-copies${sep}${name}`, name };
}
