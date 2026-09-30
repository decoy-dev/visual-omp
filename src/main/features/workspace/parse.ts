import { z } from "zod";
import type { RemoteProblem } from "@shared/contracts/workspace";

const OWNER_REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const SCP_RE = /^[\w.-]+@[\w.-]+:[^\s]+$/;
const HOST_PATH_RE = /^[\w-]+(?:\.[\w-]+)+\/[^\s]+$/;

/**
 * What a user typed into "Clone from GitHub" as a URL git accepts: full https/ssh/git URLs and
 * `git@host:path` pass through; `owner/repo` and `github.com/owner/repo` become GitHub https.
 * Null when it cannot be a repository link.
 */
export function normalizeRemote(input: string): string | null {
	const text = input.trim().replace(/\/+$/, "");
	if (!text || /\s/.test(text)) return null;
	const ownerRepo = OWNER_REPO_RE.exec(text);
	if (ownerRepo) return `https://github.com/${ownerRepo[1]}/${ownerRepo[2]?.replace(/\.git$/, "")}.git`;
	if (SCP_RE.test(text)) return text;
	if (HOST_PATH_RE.test(text)) return `https://${text}`;
	try {
		const url = new URL(text);
		if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) return null;
		return text;
	} catch {
		return null;
	}
}

/** Map `git ls-remote` failure output to a plain problem. */
export function classifyRemoteError(stderr: string): RemoteProblem {
	if (/could not resolve host|unable to access|connection (?:timed out|refused)|network is unreachable|operation timed out/i.test(stderr)) {
		// "unable to access" also wraps 404s from some hosts; a 404/403 means the server answered.
		if (/error: 40[34]|returned error: 40[34]|not found/i.test(stderr)) return "notFound";
		return "unreachable";
	}
	return "notFound";
}

const CostEntry = z.object({
	type: z.literal("message"),
	timestamp: z.string(),
	message: z.object({
		role: z.literal("assistant"),
		usage: z.object({ cost: z.object({ total: z.number() }) }),
	}),
});

/** `[epoch ms, USD]` of an assistant reply line in an omp session file; null for any other line. */
export function replyCost(line: string): [number, number] | null {
	// Cheap prefilter: only assistant replies carry a usage block.
	if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
	let json: unknown;
	try {
		json = JSON.parse(line);
	} catch {
		return null;
	}
	const parsed = CostEntry.safeParse(json);
	if (!parsed.success) return null;
	const at = Date.parse(parsed.data.timestamp);
	return Number.isFinite(at) ? [at, parsed.data.message.usage.cost.total] : null;
}
