/** Project-home stats and repository-link checks (see `@shared/contracts/workspace`). */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ProjectWeekStats } from "@shared/contracts/usage";
import type { RemoteCheck } from "@shared/contracts/workspace";
import { parseGitHubUrl, repoNameFromUrl } from "../git/parse";
import { runGit } from "../git/run";
import { handle } from "../ipc";
import { listSessions } from "../omp/sessions";
import { classifyRemoteError, normalizeRemote, replyCost } from "./workspace/parse";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const REMOTE_CHECK_TIMEOUT_MS = 20_000;

/** Reply costs per session file, keyed by path; re-read only when size or mtime changes. */
const costCache = new Map<string, { mtimeMs: number; size: number; costs: [number, number][] }>();

async function fileCosts(file: string): Promise<[number, number][]> {
	const { mtimeMs, size } = await stat(file);
	const hit = costCache.get(file);
	if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.costs;
	const costs: [number, number][] = [];
	const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of lines) {
		const cost = replyCost(line);
		if (cost) costs.push(cost);
	}
	costCache.set(file, { mtimeMs, size, costs });
	return costs;
}

/** A chat's own file plus its helper (subagent) session files, which omp keeps in `<file minus .jsonl>/`. */
async function chatFiles(file: string): Promise<string[]> {
	const dir = file.replace(/\.jsonl$/, "");
	const nested = await readdir(dir, { recursive: true }).catch(() => []);
	return [file, ...nested.filter(name => name.endsWith(".jsonl")).map(name => join(dir, name))];
}

export async function projectWeek(cwd: string): Promise<ProjectWeekStats> {
	const since = Date.now() - WEEK_MS;
	const recent = (await listSessions(cwd)).filter(session => session.updatedAt >= since);
	const files = (await Promise.all(recent.map(session => chatFiles(session.file)))).flat();
	let costUsd = 0;
	for (const costs of await Promise.all(files.map(file => fileCosts(file).catch(() => [])))) {
		for (const [at, usd] of costs) if (at >= since) costUsd += usd;
	}
	return { since, chats: recent.length, costUsd };
}

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
