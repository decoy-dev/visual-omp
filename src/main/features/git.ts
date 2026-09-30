import { shell } from "electron";
import { clone, cancelClone } from "../git/clone";
import { authStatus, ciFailures, createPr, prStatus } from "../git/github";
import { aiCommit, cancelCommit, generateCommitMessage } from "../git/omp-commit";
import {
	branches,
	commit,
	diff,
	discard,
	init,
	pushBranch,
	repoInfo,
	status,
	worktreeAdd,
	worktreeRemove,
	worktrees,
} from "../git/repo";
import { unwatchRepo, watchRepo } from "../git/watch";
import { broadcast, handle } from "../ipc";

export function register(): void {
	handle("git:repo", cwd => repoInfo(cwd));
	handle("git:status", cwd => status(cwd));
	handle("git:diff", (cwd, options) => diff(cwd, options));
	handle("git:discard", (cwd, paths) => discard(cwd, paths, path => shell.trashItem(path)));
	handle("git:init", (dir, options) => init(dir, options));
	handle("git:clone", options => clone(options, progress => broadcast("git:cloneProgress", progress)));
	handle("git:cloneCancel", id => cancelClone(id));
	handle("git:branches", cwd => branches(cwd));
	handle("git:worktrees", cwd => worktrees(cwd));
	handle("git:worktreeAdd", (cwd, options) => worktreeAdd(cwd, options));
	handle("git:worktreeRemove", (cwd, path, force) => worktreeRemove(cwd, path, force));
	handle("git:commitMessage", (cwd, options) =>
		generateCommitMessage(cwd, options ?? {}, line => broadcast("git:commitProgress", { cwd, line })),
	);
	handle("git:commitAi", (cwd, options) =>
		aiCommit(cwd, options ?? {}, line => broadcast("git:commitProgress", { cwd, line })),
	);
	handle("git:commitCancel", cwd => cancelCommit(cwd));
	handle("git:commit", (cwd, options) => commit(cwd, options));
	handle("git:push", cwd => pushBranch(cwd));
	handle("git:watch", cwd => watchRepo(cwd, (watched, root) => broadcast("git:changed", { cwd: watched, root })));
	handle("git:unwatch", cwd => unwatchRepo(cwd));

	handle("gh:auth", () => authStatus());
	handle("gh:prCreate", (cwd, options) => createPr(cwd, options));
	handle("gh:prStatus", cwd => prStatus(cwd));
	handle("gh:ciFailures", (cwd, options) => ciFailures(cwd, options?.maxLines));
}
