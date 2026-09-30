/**
 * Git and GitHub (`gh`) services for the status bar, diff review, commit, worktree, clone and
 * PR/CI surfaces.
 *
 * Paths: `cwd` arguments may be any directory inside a work tree; results report the repo `root`
 * (absolute) and file `path`s relative to it with `/` separators. Every channel rejects with an
 * `Error` whose message is git's/gh's own stderr when the underlying command fails, or
 * `"git is not installed"` / `"GitHub CLI (gh) is not installed"` when the binary is missing.
 *
 * omp capability notes:
 * - `omp commit` has no JSON mode. `git:commitMessage` runs `omp commit --dry-run` and parses the
 *   "Generated commit message:" block; `git:commitAi` runs the real command and derives the created
 *   commits from `HEAD` movement. omp exits 1 when it fell back to its mechanical message even
 *   though a commit was made; that is reported as `usedFallback`, not as an error.
 * - `omp worktree add` is used for creating worktrees: it copy-on-write clones the checkout
 *   (APFS/Btrfs/reflink, including ignored build output) and registers a real git worktree, falling
 *   back to a plain checkout. `omp worktree list` only covers agent-managed trees under
 *   `~/.omp/wt`, so listing/removal use `git worktree` directly.
 */

/** A configured remote (fetch URL). */
export interface GitRemote {
	name: string;
	url: string;
}

/** The GitHub repository a remote points at. */
export interface GitHubRepoRef {
	/** Remote name the ref was taken from (prefers `origin`, then `upstream`, then the first). */
	remote: string;
	host: string;
	owner: string;
	repo: string;
	/** `https://<host>/<owner>/<repo>`. */
	webUrl: string;
}

export interface GitRepoInfo {
	/** False when `cwd` is not inside a git work tree (all other fields are then null/empty). */
	isRepo: boolean;
	/** Absolute work-tree root. */
	root: string | null;
	/** Absolute git dir (`.git`, or `<common>/worktrees/<name>` for a linked worktree). */
	gitDir: string | null;
	/** Absolute common git dir shared by all worktrees. */
	commonDir: string | null;
	/** True for a linked worktree (not the main checkout). */
	isLinkedWorktree: boolean;
	/** False on an unborn branch (fresh `git init`). */
	hasCommits: boolean;
	remotes: GitRemote[];
	hasRemote: boolean;
	/** First GitHub remote (github.com, or a host containing "github"), null when there is none. */
	github: GitHubRepoRef | null;
}

/** What changed on one side (index = staged, worktree = unstaged) of a tracked path. */
export type GitSideChange = "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange";

/** One-word summary of a path's change relative to HEAD, for icons and colors. */
export type GitChangeKind = GitSideChange | "untracked" | "conflicted";

/** Unmerged path states (`git status` "both modified", "deleted by them", …). */
export type GitConflictKind =
	| "both-modified"
	| "both-added"
	| "both-deleted"
	| "added-by-us"
	| "added-by-them"
	| "deleted-by-us"
	| "deleted-by-them";

/** An operation git is in the middle of; conflicts are only resolvable in this context. */
export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export interface GitFileStatus {
	/** Repo-relative path (the new path for renames/copies). */
	path: string;
	/** Source path of a rename/copy; null otherwise. */
	origPath: string | null;
	kind: GitChangeKind;
	/** Staged change; null when the index matches HEAD for this path (always null for untracked). */
	index: GitSideChange | null;
	/** Unstaged change; null when the work tree matches the index. */
	worktree: GitSideChange | null;
	conflict: GitConflictKind | null;
	/** Path is a submodule. */
	submodule: boolean;
	/** Lines added vs HEAD (staged + unstaged); null for binary files or when not counted. */
	additions: number | null;
	/** Lines deleted vs HEAD; null for binary files or when not counted. */
	deletions: number | null;
	binary: boolean;
}

export interface GitStatusTotals {
	files: number;
	/** Paths with a staged change. */
	staged: number;
	/** Paths with an unstaged change to a tracked file. */
	unstaged: number;
	untracked: number;
	conflicted: number;
	/** Sum of known per-file line counts (binary / uncounted files excluded). */
	additions: number;
	deletions: number;
}

export interface GitStatus {
	root: string;
	/** Current branch; null when HEAD is detached. */
	branch: string | null;
	/** HEAD commit id; null on an unborn branch. */
	head: string | null;
	detached: boolean;
	/** Branch has no commits yet. */
	unborn: boolean;
	/** Upstream like `origin/main`; null when none is configured. */
	upstream: string | null;
	/** Commits ahead of / behind the upstream (0 without an upstream or when it is gone). */
	ahead: number;
	behind: number;
	operation: GitOperation | null;
	files: GitFileStatus[];
	totals: GitStatusTotals;
}

export type GitDiffLineKind = "context" | "add" | "del";

export interface GitDiffLine {
	kind: GitDiffLineKind;
	/** Line text without the leading marker or trailing newline. */
	text: string;
	/** 1-based line in the old file; null for additions. */
	oldLine: number | null;
	/** 1-based line in the new file; null for deletions. */
	newLine: number | null;
	/** Followed by "\ No newline at end of file". */
	noNewline: boolean;
}

export interface GitDiffHunk {
	/** The full `@@ -a,b +c,d @@ section` line. */
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** Function/section context git prints after the second `@@`. */
	section: string;
	lines: GitDiffLine[];
}

export interface GitFileDiff {
	path: string;
	/** Old path of a rename/copy; null otherwise. */
	origPath: string | null;
	kind: "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange";
	/** File was untracked (synthesized as an all-added diff). */
	untracked: boolean;
	binary: boolean;
	/** Octal modes like "100644"; null when absent on that side. */
	oldMode: string | null;
	newMode: string | null;
	additions: number;
	deletions: number;
	hunks: GitDiffHunk[];
	/** The raw unified diff for this file (headers included), ready for copy/apply. */
	patch: string;
	/** Patch exceeded the size limit: `hunks` is empty and `patch` holds only the headers. */
	truncated: boolean;
}

export interface GitDiffOptions {
	/** Restrict to these repo-relative paths (a rename is matched by either side). Omit for all changes. */
	paths?: string[];
	/** Context lines around changes (git default 3). */
	context?: number;
	/** Ignore whitespace-only changes (`-w`). */
	ignoreWhitespace?: boolean;
	/** Include untracked files as additions (default true). */
	untracked?: boolean;
}

export interface GitDiff {
	root: string;
	/** What the work tree was compared with: HEAD, or the empty tree on an unborn branch. */
	base: "HEAD" | "empty";
	files: GitFileDiff[];
}

export interface GitCloneOptions {
	/** Caller-chosen id; progress events carry it and `git:cloneCancel` takes it. */
	id: string;
	/** Any URL git accepts (https, ssh, `owner/repo` is NOT expanded; pass a full URL). */
	url: string;
	/** Directory the clone is created in. */
	parentDir: string;
	/** Folder name inside `parentDir`; defaults to the repository name from the URL. */
	name?: string;
	branch?: string;
	/** Shallow clone depth. */
	depth?: number;
}

export type GitClonePhase =
	| "starting"
	| "enumerating"
	| "counting"
	| "compressing"
	| "receiving"
	| "resolving"
	| "checkout"
	| "done";

export interface GitCloneProgress {
	id: string;
	phase: GitClonePhase;
	/** 0–100 within the current phase; null when git reports no percentage. */
	percent: number | null;
	/** Overall 0–100 estimate across phases, monotonic. */
	overall: number;
	/** Latest progress line from git (e.g. "Receiving objects:  45% (450/1000), 1.2 MiB | 2 MiB/s"). */
	message: string;
}

export interface GitCloneResult {
	id: string;
	ok: boolean;
	cancelled: boolean;
	/** Absolute path of the new checkout (set even on failure: where it would have been). */
	path: string;
	/** git's error output when `ok` is false and not cancelled. */
	error: string | null;
}

export interface GitBranch {
	/** Short name: `main`, or `origin/main` for remote branches. */
	name: string;
	/** Full ref, e.g. `refs/heads/main`. */
	ref: string;
	/** Remote name for remote-tracking branches; null for local ones. */
	remote: string | null;
	commit: string;
	subject: string;
	/** Committer date, epoch ms. */
	date: number;
	/** Configured upstream (local branches). */
	upstream: string | null;
	/** Upstream is configured but no longer exists. */
	upstreamGone: boolean;
	ahead: number;
	behind: number;
	current: boolean;
	/** Worktree where this branch is checked out, if any. */
	worktreePath: string | null;
}

export interface GitBranches {
	/** Current branch; null when detached. */
	current: string | null;
	detached: boolean;
	head: string | null;
	/** Local branches, most recently committed first. */
	local: GitBranch[];
	/** Remote-tracking branches (without `<remote>/HEAD`), most recent first. */
	remote: GitBranch[];
}

export interface GitWorktree {
	path: string;
	head: string | null;
	/** Short branch name; null when detached or bare. */
	branch: string | null;
	detached: boolean;
	bare: boolean;
	locked: boolean;
	lockReason: string | null;
	/** git considers the worktree stale (its directory is gone). */
	prunable: boolean;
	pruneReason: string | null;
	/** The main checkout (first entry). */
	isMain: boolean;
	/** The worktree containing the `cwd` passed to `git:worktrees`. */
	isCurrent: boolean;
}

export interface GitWorktreeAddOptions {
	/** Destination directory (absolute or relative to the repo root); must not exist or be empty. */
	path: string;
	/**
	 * Create this new branch for the worktree (fails if it exists). With neither `branch`, `base`
	 * nor `detach`, omp checks out (creating from HEAD if needed) a branch named after the folder.
	 */
	branch?: string;
	/** Commit-ish to start from (default HEAD). Without `branch`, a local branch name here is checked out; anything else is detached. */
	base?: string;
	/** Detached HEAD at `base`. */
	detach?: boolean;
}

export interface GitWorktreeAddResult {
	worktree: GitWorktree;
	/** omp's output ("Cloned from … via apfs", clone fallback warnings). */
	log: string;
}

export interface GitCommitRef {
	sha: string;
	subject: string;
}

export interface GitCommitResult {
	/** Commits created, oldest first (omp may split one change set into several). Empty when nothing was committed. */
	commits: GitCommitRef[];
	pushed: boolean;
	/** omp wrote the message with its mechanical fallback instead of the model. */
	usedFallback: boolean;
	/** Warnings omp printed (e.g. "Commit generated using fallback due to agent failure"). */
	warnings: string[];
	/** Full command output. */
	log: string;
}

export interface GitGenerateOptions {
	/** Extra instructions for the model (`omp commit --context`). */
	context?: string;
	/** Model override (`omp commit --model`), e.g. "anthropic/claude-sonnet-4-5". */
	model?: string;
}

export interface GitAiCommitOptions extends GitGenerateOptions {
	/** Push after committing. */
	push?: boolean;
	/** Let omp update CHANGELOG.md files it detects (omp default: true). */
	changelog?: boolean;
}

export interface GitProposedCommit {
	message: string;
	/** omp's per-commit change summary for split plans ("a.ts (all), b.ts (hunks 1, 2)"); null for a single commit. */
	changes: string | null;
}

export interface GitGeneratedMessage {
	/** One entry normally; several when omp proposes splitting the change set. */
	commits: GitProposedCommit[];
	usedFallback: boolean;
	warnings: string[];
	log: string;
}

export interface GitManualCommitOptions {
	/** Commit message as the user edited it (used verbatim, may be multi-line). */
	message: string;
	/**
	 * What to commit: `"all"` stages every change incl. untracked (default), `"staged"` commits the
	 * index as is, or a list of repo-relative paths (staged, then committed alone).
	 */
	stage?: "all" | "staged" | string[];
	amend?: boolean;
	push?: boolean;
}

export interface GitPushResult {
	remote: string;
	branch: string;
	/** Upstream was missing and was set with `-u`. */
	setUpstream: boolean;
	log: string;
}

/** A line of progress from a running `omp commit`. */
export interface GitCommitProgress {
	cwd: string;
	line: string;
}

export interface GitChangedEvent {
	/** The directory passed to `git:watch`. */
	cwd: string;
	root: string;
}

export interface GhAccount {
	/** null when gh only reports a token (e.g. an invalid `GH_TOKEN`) without an account name. */
	login: string | null;
	active: boolean;
	/** Token works. */
	ok: boolean;
	/** Where the token comes from: "keyring", "GH_TOKEN", "oauth_token", … */
	source: string | null;
	protocol: string | null;
	scopes: string[];
	/** gh's explanation when `ok` is false. */
	error: string | null;
}

export interface GhAuthStatus {
	/** `gh` is on PATH. */
	installed: boolean;
	/** The active github.com account has a working token. */
	loggedIn: boolean;
	host: "github.com";
	/** Active account login. */
	account: string | null;
	accounts: GhAccount[];
	/** Human-readable reason when not logged in / not installed. */
	problem: string | null;
}

export interface GhPrCreateOptions {
	title: string;
	body: string;
	draft?: boolean;
	/** Base branch; gh's default (the repo default branch) when omitted. */
	base?: string;
}

export interface GhPrCreateResult {
	url: string;
	number: number;
	/** The branch was pushed (and its upstream set when missing) before creating the PR. */
	pushed: boolean;
}

/** Normalized check: GitHub Actions/other check runs and legacy commit statuses alike. */
export interface GhCheck {
	name: string;
	/** Workflow name for Actions check runs. */
	workflow: string | null;
	status: "queued" | "in_progress" | "completed";
	/** Set when completed. */
	conclusion:
		| "success"
		| "failure"
		| "cancelled"
		| "skipped"
		| "neutral"
		| "timed_out"
		| "action_required"
		| "stale"
		| null;
	/** Summary bucket for badges. */
	bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
	url: string | null;
	/** Epoch ms. */
	startedAt: number | null;
	completedAt: number | null;
}

export interface GhChecksSummary {
	total: number;
	passing: number;
	failing: number;
	pending: number;
	skipped: number;
	cancelled: number;
}

export interface GhPullRequest {
	number: number;
	url: string;
	title: string;
	state: "open" | "closed" | "merged";
	draft: boolean;
	/** null when no review is required and none was given. */
	reviewDecision: "approved" | "changes_requested" | "review_required" | null;
	mergeable: "mergeable" | "conflicting" | "unknown";
	/** GitHub merge state ("clean", "dirty", "blocked", "behind", "unstable", "has_hooks", "draft", "unknown"). */
	mergeState: string;
	baseBranch: string;
	headBranch: string;
	checks: GhCheck[];
	checksSummary: GhChecksSummary;
}

export interface GhFailedStep {
	/** The step's command/title as shown in the log ("Run npm test"). */
	step: string;
	/** Last log lines of the step up to its error, timestamps and ANSI codes stripped. */
	excerpt: string;
	/** `##[error]` annotations in this step. */
	errors: string[];
}

export interface GhFailedCheck {
	name: string;
	workflow: string | null;
	url: string | null;
	conclusion: GhCheck["conclusion"];
	/** False for non-Actions checks (external CI) or when the log could not be fetched. */
	logAvailable: boolean;
	steps: GhFailedStep[];
	/** Why the log is unavailable. */
	error: string | null;
}

export interface GhCiFailures {
	pr: number;
	url: string;
	checks: GhFailedCheck[];
	/** Markdown summary of all failures, suitable as a "Fix CI" prompt for omp. */
	text: string;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Detect whether `cwd` is in a git work tree; root, remotes, GitHub owner/repo. */
		"git:repo": { args: [cwd: string]; result: GitRepoInfo };
		/** Branch/upstream/ahead-behind and every changed path with +/- line counts vs HEAD. */
		"git:status": { args: [cwd: string]; result: GitStatus };
		/** Unified diff of the work tree vs HEAD (untracked files as additions). */
		"git:diff": { args: [cwd: string, options?: GitDiffOptions]; result: GitDiff };
		/**
		 * DANGER — irreversibly drops all staged and unstaged changes to these repo-relative paths,
		 * restoring them to HEAD. Untracked/newly added files are moved to the OS trash; a rename is
		 * undone (the old path is restored, the new one trashed). Callers must confirm with the user.
		 */
		"git:discard": { args: [cwd: string, paths: string[]]; result: void };
		/** `git init` (creating `dir` if needed). */
		"git:init": { args: [dir: string, options?: { initialBranch?: string }]; result: GitRepoInfo };
		/** Clone with `git:cloneProgress` events; resolves when the clone finishes, fails or is cancelled. */
		"git:clone": { args: [options: GitCloneOptions]; result: GitCloneResult };
		/** Cancel a running clone (the partial directory is removed). False when no clone has that id. */
		"git:cloneCancel": { args: [id: string]; result: boolean };
		"git:branches": { args: [cwd: string]; result: GitBranches };
		/** All worktrees of the repository (`git worktree list`). */
		"git:worktrees": { args: [cwd: string]; result: GitWorktree[] };
		/** Create a worktree via `omp worktree add` (copy-on-write clone when supported). */
		"git:worktreeAdd": { args: [cwd: string, options: GitWorktreeAddOptions]; result: GitWorktreeAddResult };
		/** `git worktree remove`; `force` also removes one with uncommitted changes. */
		"git:worktreeRemove": { args: [cwd: string, path: string, force?: boolean]; result: void };
		/**
		 * Ask omp for a commit message without committing (`omp commit --dry-run --no-changelog`).
		 * Streams `git:commitProgress`. Leaves the index as it was. Rejects with "No changes to commit"
		 * on a clean tree.
		 */
		"git:commitMessage": { args: [cwd: string, options?: GitGenerateOptions]; result: GitGeneratedMessage };
		/**
		 * Let omp write the message and commit (`omp commit`). Commits staged changes, or everything
		 * when nothing is staged. Streams `git:commitProgress`.
		 */
		"git:commitAi": { args: [cwd: string, options?: GitAiCommitOptions]; result: GitCommitResult };
		/** Abort the running `git:commitMessage` / `git:commitAi` for this cwd. False when none runs. */
		"git:commitCancel": { args: [cwd: string]; result: boolean };
		/** Plain `git commit` with a user-written message. */
		"git:commit": { args: [cwd: string, options: GitManualCommitOptions]; result: GitCommitResult };
		/** Push the current branch, setting its upstream on the first push. */
		"git:push": { args: [cwd: string]; result: GitPushResult };
		/** Start emitting `git:changed` for this directory's repo (reference-counted per cwd). */
		"git:watch": { args: [cwd: string]; result: void };
		"git:unwatch": { args: [cwd: string]; result: void };

		/** `gh auth status` for github.com. Never rejects. */
		"gh:auth": { args: []; result: GhAuthStatus };
		/** Push the branch if needed, then `gh pr create`. */
		"gh:prCreate": { args: [cwd: string, options: GhPrCreateOptions]; result: GhPrCreateResult };
		/** The current branch's PR with review/merge state and CI checks; null when the branch has none. */
		"gh:prStatus": { args: [cwd: string]; result: GhPullRequest | null };
		/**
		 * Logs of the current PR's failing checks, summarized for "Fix CI". Rejects when the branch
		 * has no PR. `maxLines` caps each step excerpt (default 80).
		 */
		"gh:ciFailures": { args: [cwd: string, options?: { maxLines?: number }]; result: GhCiFailures };
	}

	interface IpcEventMap {
		"git:changed": GitChangedEvent;
		"git:cloneProgress": GitCloneProgress;
		"git:commitProgress": GitCommitProgress;
	}
}
