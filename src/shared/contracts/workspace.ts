/**
 * Project-home and new-project helpers that no other area covers: this week's chat activity and
 * cost for one project folder (summed from its saved sessions), and live validation of a
 * repository link before cloning.
 */


/**
 * - `invalid`: not something git can clone (typo, not a link).
 * - `notFound`: the server answered but has no such repository, or it is private and git has no access.
 * - `unreachable`: the server could not be reached (offline, wrong host, timeout).
 */
export type RemoteProblem = "invalid" | "notFound" | "unreachable";

export interface RemoteCheck {
	input: string;
	ok: boolean;
	/** Clone URL to pass to `git:clone` (`owner/repo` expands to GitHub https); null when invalid. */
	url: string | null;
	/** Display name: `owner/repo` for GitHub, else the host and path. */
	label: string | null;
	/** Folder name the clone gets by default. */
	folderName: string;
	problem: RemoteProblem | null;
	/** git's own message for `notFound` / `unreachable`. */
	detail: string | null;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Ask the server whether a repository link works (`git ls-remote`, no credentials prompt, 20 s cap). */
		"workspace:checkRemote": { args: [input: string]; result: RemoteCheck };
	}
}
