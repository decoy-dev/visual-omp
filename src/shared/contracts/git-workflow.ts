/**
 * Git workflow actions behind the status-bar branch menu, the commit dialog and the Create PR
 * dialog that `contracts/git.ts` does not cover: switching/creating branches, choosing exactly
 * which files a commit includes, and the facts (and an omp-written draft) for a pull request.
 *
 * Every channel rejects with an `Error` carrying git's/omp's own message when the command fails.
 */

/** One commit on the branch that is not on the PR base yet. */
export interface GitBranchCommit {
	sha: string;
	subject: string;
	/** Message body after the subject line, trimmed; empty when there is none. */
	body: string;
}

export interface GitPrContext {
	/** Current branch; null when HEAD is detached. */
	branch: string | null;
	/** GitHub remote the PR goes to (`origin` usually); null when the repo has no GitHub remote. */
	remote: string | null;
	/** Branches on that remote a PR can target (without the `<remote>/` prefix), current branch excluded. */
	bases: string[];
	/** The remote's default branch (`<remote>/HEAD`), else `main`/`master` when present, else the first base. */
	defaultBase: string | null;
}

export interface GitPrDraft {
	title: string;
	body: string;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/**
		 * Check out an existing branch: a local name, or `<remote>/<name>` to create a local branch
		 * tracking it. Refuses with "You have unsaved changes…" when tracked files are modified,
		 * staged or conflicted (untracked files travel along untouched).
		 */
		"git:switch": { args: [cwd: string, branch: string]; result: void };
		/** Create a branch from HEAD and switch to it, keeping every uncommitted change. Validates the name. */
		"git:branchCreate": { args: [cwd: string, name: string]; result: void };
		/** Make the index hold exactly these repo-relative paths' current contents (nothing else staged). */
		"git:stageOnly": { args: [cwd: string, paths: string[]]; result: void };
		/** Remote, base branches and default base for a pull request from the current branch. */
		"git:prContext": { args: [cwd: string]; result: GitPrContext };
		/** Commits in `<remote>/<base>..HEAD`, oldest first (the whole branch history when the base is unknown, capped at 50). */
		"git:branchCommits": { args: [cwd: string, base: string | null]; result: GitBranchCommit[] };
		/** Ask omp (non-interactive, no tools) for a PR title and description from the commits and diff against `base`. */
		"git:prWrite": { args: [cwd: string, base: string | null]; result: GitPrDraft };
	}
}
