/**
 * Update checks for the app itself (GitHub Releases of decoy-dev/visual-omp) and for the omp
 * engine (`omp update --check` / `omp update`).
 */

/** One downloadable file attached to a GitHub release. */
export interface ReleaseAsset {
	name: string;
	/** Direct download URL (`browser_download_url`). */
	url: string;
	/** Bytes. */
	size: number;
}

/**
 * How the user installs an app update on this platform.
 * - `command`: run `command` in a terminal (macOS Homebrew cask).
 * - `download`: download and run the installer at `url` (Windows NSIS installer).
 * - `page`: no matching installer asset; open the release page at `url`.
 */
export type AppUpdateHint =
	| { kind: "command"; command: string; url: string }
	| { kind: "download"; url: string; fileName: string }
	| { kind: "page"; url: string };

export interface AppUpdateStatus {
	/** `app.getVersion()` of the running app. */
	currentVersion: string;
	/** Newest published (non-draft) release version without the leading `v`; null when none is published. */
	latestVersion: string | null;
	/** True when `latestVersion` is a strictly newer semver than `currentVersion`. */
	updateAvailable: boolean;
	/** Release tag as published, e.g. `v0.2.0`. */
	tag: string | null;
	releaseName: string | null;
	/** Release notes (GitHub-flavoured Markdown). */
	notes: string | null;
	/** Release page URL. */
	releaseUrl: string | null;
	/** Epoch ms. */
	publishedAt: number | null;
	assets: ReleaseAsset[];
	/** Installer asset for this platform/arch (`.dmg`/`.zip` on macOS, `.exe` on Windows), if any. */
	platformAsset: ReleaseAsset | null;
	/** Platform-specific instructions; null when no release is published. */
	hint: AppUpdateHint | null;
	/** Epoch ms of the last successful GitHub fetch; 0 when it never succeeded. */
	checkedAt: number;
	/** True when served from the 6-hour cache without contacting GitHub. */
	fromCache: boolean;
	/** Last fetch error (network, rate limit); the other fields then hold the last good result. */
	error: string | null;
}

export type OmpUpdateChannel = "stable" | "canary";

export interface OmpUpdateStatus {
	/** Installed omp version reported by `omp update --check`; null if omp is missing or the check failed early. */
	currentVersion: string | null;
	/** Newer version omp offers; null when up to date or unknown. */
	latestVersion: string | null;
	updateAvailable: boolean;
	channel: OmpUpdateChannel;
	/** omp's npm package was renamed; updating migrates the install to this package. */
	packageMovedTo: string | null;
	/** Epoch ms of the check that produced this result. */
	checkedAt: number;
	/** True when served from the 6-hour cache. */
	fromCache: boolean;
	/** Why the check failed (e.g. GitHub rate limit — set GITHUB_TOKEN/GH_TOKEN, omp not installed). */
	error: string | null;
}

export interface OmpUpdateOptions {
	/** `--force`: reinstall even when already up to date. */
	force?: boolean;
	/** `--plugins`: upgrade installed omp plugins instead of omp itself. */
	plugins?: boolean;
}

/** One `omp update` invocation. Output is also streamed live via `updates:omp:output`. */
export interface OmpUpdateRun {
	runId: string;
	/** omp argv, e.g. `["update"]`, `["update", "--force"]`. */
	args: string[];
	/** Epoch ms. */
	startedAt: number;
	/** Epoch ms; null while running. */
	finishedAt: number | null;
	/** Process exit code; null while running. */
	exitCode: number | null;
	/** Combined stdout + stderr so far (ANSI-free: runs with NO_COLOR). */
	output: string;
	/** `omp --version` after the run finished; null while running or if omp no longer starts. */
	versionAfter: string | null;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/**
		 * Latest GitHub release vs the running app. Cached 6 hours (persisted across restarts);
		 * `force` bypasses the cache (the "Check now" button). Never rejects: failures land in `error`.
		 */
		"updates:app:check": { args: [force?: boolean]; result: AppUpdateStatus };
		/** `omp update --check`, cached 6 hours; `force` bypasses the cache. Never rejects. */
		"updates:omp:check": { args: [force?: boolean]; result: OmpUpdateStatus };
		/**
		 * Start `omp update` (omp picks brew/bun/npm/mise/binary itself). Returns immediately with the
		 * run snapshot; output streams via `updates:omp:output`, completion via `updates:omp:finished`.
		 * If a run is already in progress, returns that run instead of starting another. Running chat
		 * sessions keep the old engine until they are restarted.
		 */
		"updates:omp:run": { args: [options?: OmpUpdateOptions]; result: OmpUpdateRun };
		/** The current or most recent `omp update` run of this app session, for views opened mid-run. */
		"updates:omp:lastRun": { args: []; result: OmpUpdateRun | null };
	}
	interface IpcEventMap {
		/** A fresh app release check finished (background every 6 hours, or forced). */
		"updates:app": AppUpdateStatus;
		/** A chunk of `omp update` output. */
		"updates:omp:output": { runId: string; stream: "stdout" | "stderr"; data: string };
		/** `omp update` exited; omp status and the omp update-check cache are refreshed first. */
		"updates:omp:finished": OmpUpdateRun;
	}
}
