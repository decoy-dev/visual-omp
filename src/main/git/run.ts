import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { CliResult } from "@shared/ipc";
import { userEnv } from "../env";

/** Hard cap on captured output so a runaway command cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export interface RunOptions {
	cwd?: string;
	/** Written to stdin, which is then closed. stdin is closed immediately when omitted. */
	input?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	onStdout?(chunk: string): void;
	onStderr?(chunk: string): void;
}

export interface RunResult extends CliResult {
	/** The process was stopped by `signal`. */
	aborted: boolean;
}

/** Friendly names for binaries whose absence the UI should explain. */
const MISSING_MESSAGE: Record<string, string> = {
	git: "git is not installed",
	gh: "GitHub CLI (gh) is not installed",
};

export class MissingBinaryError extends Error {
	constructor(readonly bin: string) {
		super(MISSING_MESSAGE[bin] ?? `${bin} is not installed`);
		this.name = "MissingBinaryError";
	}
}

/** Spawn a process and capture its output. Resolves on any exit code; rejects only when it cannot start. */
export function run(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
	const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
	const child = spawn(bin, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		timeout: options.timeoutMs,
		signal: options.signal,
		windowsHide: true,
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let bytes = 0;
	let overflow = false;
	const collect = (sink: Buffer[], listener?: (chunk: string) => void) => (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes > MAX_OUTPUT_BYTES) {
			overflow = true;
			child.kill();
			return;
		}
		sink.push(chunk);
		listener?.(chunk.toString("utf8"));
	};
	child.stdout.on("data", collect(stdout, options.onStdout));
	child.stderr.on("data", collect(stderr, options.onStderr));
	child.stdin.on("error", () => {});
	child.stdin.end(options.input ?? "");
	child.once("error", error => {
		if ("code" in error && error.code === "ENOENT") {
			const missingCwd = options.cwd !== undefined && !existsSync(options.cwd);
			reject(missingCwd ? new Error(`Folder not found: ${options.cwd}`) : new MissingBinaryError(bin));
		} else if (error.name !== "AbortError") reject(error);
	});
	child.once("close", (code, signal) => {
		const err = Buffer.concat(stderr).toString("utf8");
		resolve({
			code: code ?? (signal ? 128 : 1),
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: overflow ? `${err}\noutput exceeded ${MAX_OUTPUT_BYTES} bytes` : err,
			aborted: options.signal?.aborted ?? false,
		});
	});
	return promise;
}

/** Error carrying the failed command's output; its message is the command's stderr. */
export class CommandError extends Error {
	constructor(
		message: string,
		readonly result: CliResult,
	) {
		super(message);
		this.name = "CommandError";
	}
}

export function failure(label: string, result: CliResult): CommandError {
	const detail = result.stderr.trim() || result.stdout.trim() || `exited with code ${result.code}`;
	return new CommandError(`${label}: ${detail}`, result);
}

/**
 * Environment for git: never prompt for credentials (a GUI has no terminal to answer on), never take
 * optional locks (so status polling doesn't rewrite the index and retrigger the watcher), and use
 * untranslated messages so progress lines are parseable.
 */
async function gitEnv(): Promise<NodeJS.ProcessEnv> {
	const env = { ...(await userEnv()) };
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_OPTIONAL_LOCKS = "0";
	env.GCM_INTERACTIVE = "never";
	// Every path we pass is a literal file name, never a glob.
	env.GIT_LITERAL_PATHSPECS = "1";
	env.LANGUAGE = "C";
	env.LC_MESSAGES = "C";
	return env;
}

/** Config that makes machine-read output independent of the user's git config. */
const GIT_BASE_ARGS = ["-c", "core.quotePath=false", "-c", "color.ui=false", "-c", "log.showSignature=false"];

export type GitRunOptions = Omit<RunOptions, "env"> & { cwd: string };

/** Run git; never rejects on non-zero exit. */
export async function runGit(args: string[], options: GitRunOptions): Promise<RunResult> {
	return run("git", [...GIT_BASE_ARGS, ...args], { timeoutMs: 120_000, ...options, env: await gitEnv() });
}

/** Run git and return stdout; rejects with git's stderr on failure. */
export async function git(args: string[], options: GitRunOptions): Promise<string> {
	const result = await runGit(args, options);
	if (result.code !== 0) throw failure(`git ${args[0]}`, result);
	return result.stdout;
}

async function ghEnv(): Promise<NodeJS.ProcessEnv> {
	const env = { ...(await gitEnv()) };
	env.GH_PROMPT_DISABLED = "1";
	env.GH_NO_UPDATE_NOTIFIER = "1";
	env.GH_SPINNER_DISABLED = "1";
	env.NO_COLOR = "1";
	env.CLICOLOR = "0";
	env.GH_PAGER = "";
	return env;
}

/** Run gh; never rejects on non-zero exit. */
export async function runGh(args: string[], options: Omit<RunOptions, "env"> = {}): Promise<RunResult> {
	return run("gh", args, { timeoutMs: 60_000, ...options, env: await ghEnv() });
}

/** Run gh and return stdout; rejects with gh's stderr on failure. */
export async function gh(args: string[], options: Omit<RunOptions, "env"> = {}): Promise<string> {
	const result = await runGh(args, options);
	if (result.code !== 0) throw failure(`gh ${args.slice(0, 2).join(" ")}`, result);
	return result.stdout;
}
