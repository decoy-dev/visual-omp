/** Repository-link checks (see `@shared/contracts/workspace`). */
import { homedir } from "node:os";
import type { RemoteCheck } from "@shared/contracts/workspace";
import { parseGitHubUrl, repoNameFromUrl } from "../git/parse";
import { runGit } from "../git/run";
import { handle } from "../ipc";
import { classifyRemoteError, normalizeRemote } from "./workspace/parse";

const REMOTE_CHECK_TIMEOUT_MS = 20_000;

async function checkRemote(input: string): Promise<RemoteCheck> {
	const url = normalizeRemote(input);
	const base = { input, url, folderName: repoNameFromUrl(url ?? input) };
	if (!url) return { ...base, ok: false, label: null, problem: "invalid", detail: null };
	const github = parseGitHubUrl(url);
	const label = github ? `${github.owner}/${github.repo}` : url.replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/i, "").replace(/\.git$/, "");
	const result = await runGit(["ls-remote", "--heads", url], { cwd: homedir(), timeoutMs: REMOTE_CHECK_TIMEOUT_MS });
	if (result.code === 0) return { ...base, ok: true, label, problem: null, detail: null };
	const detail = result.stderr.trim() || null;
	// A killed (timed out) git exits by signal with no output.
	return { ...base, ok: false, label, problem: detail ? classifyRemoteError(detail) : "unreachable", detail };
}

export function register(): void {

	handle("workspace:checkRemote", input => checkRemote(input));
}
