import { branchCommits, createBranch, prContext, prWrite, stageOnly, switchBranch } from "../git/workflow";
import { handle } from "../ipc";

export function register(): void {
	handle("git:switch", (cwd, branch) => switchBranch(cwd, branch));
	handle("git:branchCreate", (cwd, name) => createBranch(cwd, name));
	handle("git:stageOnly", (cwd, paths) => stageOnly(cwd, paths));
	handle("git:prContext", cwd => prContext(cwd));
	handle("git:branchCommits", (cwd, base) => branchCommits(cwd, base));
	handle("git:prWrite", (cwd, base) => prWrite(cwd, base));
}
