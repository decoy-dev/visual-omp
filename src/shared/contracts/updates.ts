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
	/** GitHub's asset digest, when supplied (sha256:<hex>). */
	digest?: string | null;
}

/**
 * How this copy of visual-omp was installed, which decides how it updates.
 * - `brew`: Homebrew cask; `brew upgrade --cask visual-omp` runs in a terminal, then the app restarts.
 * - `dmg`: macOS without Homebrew; the disk image downloads to ~/Downloads and opens in Finder.
 * - `scoop`: Windows with Scoop; the app quits, `scoop update visual-omp` runs in a PowerShell
 *   window, and the updated copy starts.
 * - `nsis`: other Windows installs; the installer downloads to ~/Downloads, runs, and the app quits.
 * - `manual`: development builds and other platforms; the release page opens in the browser.
 */
export type AppInstallMethod = "brew" | "dmg" | "scoop" | "nsis" | "manual";

export interface AppInstallInfo {
	method: AppInstallMethod;
	/** The running `.app` bundle on macOS; null elsewhere. */
	appPath: string | null;
	/** Shell command that upgrades the cask (`brew` only). */
	command: string | null;
	/**
	 * `scoop` only: Scoop installed this copy for all users (`scoop install --global`). Updating it
	 * needs an administrator PowerShell, so the app shows the command instead of running it.
	 */
	scoopGlobal: boolean;
}

/** One installer download (`dmg` / `nsis`). Progress streams via `updates:app:download`. */
export interface AppDownload {
	/** Release version this installer belongs to (no leading `v`). */
	version: string;
	fileName: string;
	/** Destination in the Downloads folder. */
	filePath: string;
	received: number;
	/** Bytes; null when the server sent no length. */
	total: number | null;
	state: "downloading" | "done" | "failed" | "cancelled";
	error: string | null;
}

/**
 * What the first launch after an in-app update found (recorded before the restart, consumed once).
 * `updated` is false when the running version still equals `from`.
 */
export interface AppUpdateOutcome {
	method: AppInstallMethod;
	from: string;
	to: string;
	running: string;
	updated: boolean;
}

export interface AppReleaseNotes {
	version: string;
	body: string;
	url: string | null;
	/** Epoch ms, or null when GitHub did not provide a publication date. */
	publishedAt: number | null;
	/** Original published tag and trusted installer for this computer, absent in older caches. */
	tag?: string;
	platformAsset?: ReleaseAsset | null;
}

export interface AppUpdateStatus {
	/** `app.getVersion()` of the running app. */
	currentVersion: string;
	/** Newest published (non-draft) release version without the leading `v`; null when none is published. */
	latestVersion: string | null;
	/** True when a newer release is eligible, respecting the rollback skip unless explicitly checked. */
	updateAvailable: boolean;
	/** Release tag as published, e.g. `v0.2.0`. */
	tag: string | null;
	releaseName: string | null;
	/** Release notes (GitHub-flavoured Markdown). */
	notes: string | null;
	/** Published releases from the same GitHub response. Older on-disk caches may omit this field. */
	releases?: AppReleaseNotes[];
	/** Background checks suppress releases at or below this version after a rollback. */
	skippedThroughVersion?: string | null;
	/** Release page URL. */
	releaseUrl: string | null;
	/** Epoch ms. */
	publishedAt: number | null;
	assets: ReleaseAsset[];
	/** Installer asset for this platform/arch (`.dmg`/`.zip` on macOS, `.exe` on Windows), if any. */
	platformAsset: ReleaseAsset | null;
	/** One line from the release notes for the update toast; null when there are no notes. */
	summary: string | null;
	/** Epoch ms of the last successful GitHub fetch; 0 when it never succeeded. */
	checkedAt: number;
	/** True when served from the 30-minute cache without contacting GitHub. */
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
	/** Application responsible for this omp installation; updating is handled there. */
	managedBy?: string | null;
	/** Epoch ms of the check that produced this result. */
	checkedAt: number;
	/** True when served from the 30-minute cache. */
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
		 * Latest GitHub release vs the running app. A result younger than 30 minutes answers without
		 * contacting GitHub; `force` bypasses it (the "Check now" button and every background check,
		 * which runs shortly after launch and every 30 minutes). Never rejects: failures land in `error`.
		 * Development builds read releases from the JSON file named by `VOMP_UPDATE_FEED` instead.
		 */
		"updates:app:check": { args: [force?: boolean, includeSkipped?: boolean]; result: AppUpdateStatus };
		/** How this copy was installed (Homebrew cask, disk image, Scoop, NSIS installer) and the cask's upgrade command. */
		"updates:app:install": { args: []; result: AppInstallInfo };
		/**
		 * Download the latest installer, or a selected strictly earlier release fetched from GitHub.
		 * Uses the same trusted asset selection and download verification for either direction.
		 */
		"updates:app:download": { args: [version?: string]; result: AppDownload };
		/** An explicit choice to update after checking clears the rollback skip. */
		"updates:app:resume": { args: []; result: void };
		"updates:app:cancelDownload": { args: []; result: void };
		/**
		 * Open the downloaded installer: the disk image in Finder, or on Windows the NSIS installer,
		 * after which the app quits so the installer can replace it. The renderer confirms the quit first.
		 */
		"updates:app:runInstaller": { args: []; result: void };
		/**
		 * `CFBundleShortVersionString` of the `.app` on disk (changes when brew replaces it; null if
		 * unreadable) and whether it is a newer semver than the running app.
		 */
		"updates:app:installedVersion": { args: []; result: { version: string | null; newer: boolean } };
		/**
		 * Quit (going through the quit guard, which the renderer approves beforehand) and, with
		 * `relaunch`, open the app again once this process has exited: from the same path, so the
		 * replaced bundle starts, or for Scoop installs after `scoop update visual-omp` has run.
		 * Records the expected version for `updates:app:outcome`. Rejects in development builds.
		 */
		"updates:app:quit": { args: [relaunch: boolean]; result: void };
		/** The result of the last in-app update, once per update (the record is deleted when read). */
		"updates:app:outcome": { args: []; result: AppUpdateOutcome | null };
		/** `omp update --check`, cached 30 minutes; `force` bypasses the cache. Never rejects. */
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
		/** An app release check result: every fresh check, including the background check at launch and every 30 minutes. */
		"updates:app": AppUpdateStatus;
		/** An `omp update --check` result, on the same terms as `updates:app` (and after each `omp update`). */
		"updates:omp": OmpUpdateStatus;
		/** Installer download progress (throttled) and its final state. */
		"updates:app:download": AppDownload;
		/** A chunk of `omp update` output. */
		"updates:omp:output": { runId: string; stream: "stdout" | "stderr"; data: string };
		/** `omp update` exited; omp status and the omp update-check cache are refreshed first. */
		"updates:omp:finished": OmpUpdateRun;
	}
}
