/**
 * Git feature: status-bar branch / changes / PR-CI items, the commit and Create PR sheets, and the
 * commands behind them (commit, create PR, work in a separate copy, fix CI).
 */
import { Copy, GitCommit, GitPullRequest, Wrench } from "@phosphor-icons/react";
import { registerCommand } from "@/registry/commands";
import { sheets, statusItems } from "@/registry/slots";
import { useApp } from "@/state/app";
import { fixCi, startWorktree } from "./actions";
import { CommitSheet } from "./CommitSheet";
import { ciState } from "./format";
import { PrSheet } from "./PrSheet";
import { BranchItem, ChangesItem, PrItem } from "./StatusItems";
import { gitTracker } from "./store";

sheets.register({ id: "git-commit", component: CommitSheet });
sheets.register({ id: "git-pr", component: PrSheet });

statusItems.register({ id: "git.branch", side: "left", order: 10, component: BranchItem });
statusItems.register({ id: "git.changes", side: "left", order: 20, component: ChangesItem });
statusItems.register({ id: "git.pr", side: "left", order: 30, component: PrItem });

/** Last known git state for the command's project (commands can't await, so they read the tracker). */
const gitView = (projectPath: string | null) => (projectPath ? gitTracker(projectPath).getSnapshot() : null);

registerCommand({
	id: "git.commit",
	title: "git:commands.commit.title",
	hint: "git:commands.commit.hint",
	keywords: "git:commands.commit.keywords",
	group: "actions",
	icon: GitCommit,
	when: ({ projectPath }) => gitView(projectPath)?.repo?.isRepo !== false && projectPath !== null,
	run: ({ projectPath }) => useApp.getState().openSheet("git-commit", { cwd: projectPath }),
});

registerCommand({
	id: "git.pr",
	title: "git:commands.pr.title",
	hint: "git:commands.pr.hint",
	keywords: "git:commands.pr.keywords",
	group: "actions",
	icon: GitPullRequest,
	when: ({ projectPath }) => gitView(projectPath)?.repo?.isRepo !== false && projectPath !== null,
	run: ({ projectPath }) => useApp.getState().openSheet("git-pr", { cwd: projectPath }),
});

registerCommand({
	id: "git.worktree",
	title: "git:commands.worktree.title",
	hint: "git:commands.worktree.hint",
	keywords: "git:commands.worktree.keywords",
	group: "actions",
	icon: Copy,
	when: ({ projectPath }) => {
		const view = gitView(projectPath);
		return projectPath !== null && view?.repo?.isRepo !== false && !view?.repo?.isLinkedWorktree;
	},
	run: ({ projectPath }) => (projectPath ? startWorktree(projectPath) : undefined),
});

registerCommand({
	id: "git.fixCi",
	title: "git:commands.fixCi.title",
	hint: "git:commands.fixCi.hint",
	keywords: "git:commands.fixCi.keywords",
	group: "actions",
	icon: Wrench,
	when: ({ projectPath }) => {
		const pr = gitView(projectPath)?.pr;
		return Boolean(pr && pr.state === "open" && ciState(pr) === "fail");
	},
	run: ({ projectPath }) => (projectPath ? fixCi(projectPath) : undefined),
});
