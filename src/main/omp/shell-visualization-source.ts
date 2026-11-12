/** Exact upstream replication and persistence truncation markers. */
export function hasShellTraceElision(json: string): boolean {
	// Bound marker matching so adversarial source strings cannot cause quadratic scans in main.
	return json.includes("[Session persistence truncated large content]")
		|| /…\[(?:\d+ (?:chars|items)|deeper levels|cyclic reference) elided for collab session\]|…\[[^\]\r\n]{0,256} omitted for collab session: too large to replicate\]/.test(json);
}
