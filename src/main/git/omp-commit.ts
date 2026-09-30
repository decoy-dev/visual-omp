import type {
	GitAiCommitOptions,
	GitCommitResult,
	GitGeneratedMessage,
	GitGenerateOptions,
} from "@shared/contracts/git";
import { userEnv } from "../env";
import { ompPath } from "../omp/locate";
import { parseCommitOutput } from "./parse";
import { commitsSince, hasStagedChanges, headCommit, repoPaths, requireRepo, unstageAll } from "./repo";
import { failure, run, type RunResult } from "./run";

/** Running `omp commit` per repo root, so the UI can cancel it and two runs never race on one index. */
const running = new Map<string, AbortController>();

/** The model call can take minutes on large change sets; this only guards against a hung process. */
const OMP_COMMIT_TIMEOUT_MS = 15 * 60_000;

async function runOmpCommit(root: string, argv: string[], onLine: (line: string) => void): Promise<RunResult> {
	if (running.has(root)) throw new Error("omp commit is already running for this repository");
	const controller = new AbortController();
	running.set(root, controller);
	let pending = "";
	const emit = (chunk: string) => {
		pending += chunk;
		const lines = pending.split(/\r?\n/);
		pending = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) onLine(line);
	};
	try {
		const [bin, env] = await Promise.all([ompPath(), userEnv()]);
		const result = await run(bin, ["commit", ...argv], {
			cwd: root,
			env: { ...env, NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
			timeoutMs: OMP_COMMIT_TIMEOUT_MS,
			signal: controller.signal,
			onStdout: emit,
			onStderr: emit,
		});
		if (pending.trim()) onLine(pending);
		if (result.aborted) throw new Error("Cancelled");
		return result;
	} finally {
		running.delete(root);
	}
}

function modelArgs(options: GitGenerateOptions): string[] {
	const argv: string[] = [];
	if (options.context) argv.push("--context", options.context);
	if (options.model) argv.push("--model", options.model);
	return argv;
}

/**
 * Generate a message with `omp commit --dry-run --no-changelog`. omp stages everything when
 * nothing is staged, even in a dry run; that staging is undone so the index is left untouched.
 */
export async function generateCommitMessage(
	cwd: string,
	options: GitGenerateOptions,
	onLine: (line: string) => void,
): Promise<GitGeneratedMessage> {
	const { root } = await requireRepo(cwd);
	const stagedBefore = await hasStagedChanges(root);
	let result: RunResult;
	try {
		result = await runOmpCommit(root, ["--dry-run", "--no-changelog", ...modelArgs(options)], onLine);
	} finally {
		if (!stagedBefore && (await hasStagedChanges(root))) await unstageAll(root);
	}
	const parsed = parseCommitOutput(result.stdout, result.stderr);
	if (parsed.noChanges) throw new Error("No changes to commit");
	if (parsed.commits.length === 0) throw failure("omp commit", result);
	return {
		commits: parsed.commits,
		usedFallback: parsed.usedFallback,
		warnings: parsed.warnings,
		log: `${result.stdout}${result.stderr}`.trim(),
	};
}

/** Let omp write the message(s) and commit. Created commits are read back from HEAD movement. */
export async function aiCommit(
	cwd: string,
	options: GitAiCommitOptions,
	onLine: (line: string) => void,
): Promise<GitCommitResult> {
	const { root } = await requireRepo(cwd);
	const before = await headCommit(root);
	const argv = [
		...(options.push ? ["--push"] : []),
		...(options.changelog === false ? ["--no-changelog"] : []),
		...modelArgs(options),
	];
	const result = await runOmpCommit(root, argv, onLine);
	const parsed = parseCommitOutput(result.stdout, result.stderr);
	const commits = await commitsSince(root, before);
	// omp exits 1 after a successful fallback commit; only a run that committed nothing is a failure.
	if (result.code !== 0 && commits.length === 0) throw failure("omp commit", result);
	return {
		commits,
		pushed: Boolean(options.push) && /^Pushed to remote\.$/m.test(result.stdout),
		usedFallback: parsed.usedFallback,
		warnings: parsed.warnings,
		log: `${result.stdout}${result.stderr}`.trim(),
	};
}

export async function cancelCommit(cwd: string): Promise<boolean> {
	const paths = await repoPaths(cwd);
	const controller = paths ? running.get(paths.root) : undefined;
	controller?.abort();
	return controller !== undefined;
}
