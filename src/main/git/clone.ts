import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GitCloneOptions, GitCloneProgress, GitCloneResult } from "@shared/contracts/git";
import { pathExists } from "../files";
import { parseCloneProgress, repoNameFromUrl } from "./parse";
import { runGit } from "./run";

const clones = new Map<string, AbortController>();

/** Cloning a large repository over a slow link legitimately takes a long time. */
const CLONE_TIMEOUT_MS = 2 * 60 * 60_000;

/** `git clone --progress` into `parentDir/<name>`, reporting progress parsed from git's stderr. */
export async function clone(
	options: GitCloneOptions,
	onProgress: (progress: GitCloneProgress) => void,
): Promise<GitCloneResult> {
	if (clones.has(options.id)) throw new Error(`A clone with id ${options.id} is already running`);
	const name = options.name?.trim() || repoNameFromUrl(options.url);
	const target = join(options.parentDir, name);
	const existed = await pathExists(target);
	await mkdir(options.parentDir, { recursive: true });

	const controller = new AbortController();
	clones.set(options.id, controller);
	let overall = 0;
	let last = "";
	let pending = "";
	const report = (progress: Omit<GitCloneProgress, "id">) => {
		overall = Math.max(overall, progress.overall);
		onProgress({ ...progress, id: options.id, overall });
	};
	report({ phase: "starting", percent: null, overall: 0, message: `Cloning into '${name}'…` });

	const args = ["clone", "--progress"];
	if (options.branch) args.push("--branch", options.branch);
	if (options.depth) args.push("--depth", String(options.depth));
	args.push("--", options.url, target);
	try {
		const result = await runGit(args, {
			cwd: options.parentDir,
			signal: controller.signal,
			timeoutMs: CLONE_TIMEOUT_MS,
			onStderr: chunk => {
				pending += chunk;
				const lines = pending.split(/[\r\n]/);
				pending = lines.pop() ?? "";
				for (const line of lines) {
					const progress = parseCloneProgress(line);
					if (!progress || progress.message === last) continue;
					last = progress.message;
					report(progress);
				}
			},
		});
		const cancelled = result.aborted;
		const ok = !cancelled && result.code === 0;
		if (!ok && !existed) await rm(target, { recursive: true, force: true });
		if (ok) report({ phase: "done", percent: 100, overall: 100, message: "Done" });
		// Keep git's messages ("fatal: repository not found"), drop the progress noise.
		const messages = result.stderr
			.split(/[\r\n]/)
			.filter(line => line.trim() && !line.startsWith("Cloning into ") && !parseCloneProgress(line));
		const error = ok || cancelled ? null : messages.join("\n") || `git clone exited with ${result.code}`;
		return { id: options.id, ok, cancelled, path: target, error };
	} finally {
		clones.delete(options.id);
	}
}

export function cancelClone(id: string): boolean {
	const controller = clones.get(id);
	controller?.abort();
	return controller !== undefined;
}
