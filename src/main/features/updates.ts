import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, type FileHandle, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { app, shell } from "electron";
import type { CliResult, Platform } from "@shared/ipc";
import type {
	AppDownload,
	AppInstallInfo,
	AppInstallMethod,
	AppUpdateOutcome,
	AppUpdateStatus,
	OmpUpdateOptions,
	OmpUpdateRun,
	OmpUpdateStatus,
} from "@shared/contracts/updates";
import { userEnv } from "../env";
import { writeText } from "../files";
import { broadcast, handle } from "../ipc";
import { runOmp } from "../omp/cli";
import { ompPath, ompStatus } from "../omp/locate";
import {
	type GitHubRelease,
	GitHubReleaseList,
	type InstallerTrust,
	REPO,
	appBundlePath,
	brewCandidates,
	brewUpgradeCommand,
	caskroomPath,
	compareSemver,
	detectInstallMethod,
	fetchInstaller,
	installerAsset,
	parseOmpUpdateCheck,
	plistVersion,
	releaseSummary,
	selectLatestRelease,
	toAssets,
	trustedCachedStatus,
} from "../services/updates";

const CACHE_MS = 6 * 60 * 60 * 1000;
/** First background check shortly after launch, so startup is not slowed by the network. */
const FIRST_CHECK_DELAY_MS = 30_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_RUN_OUTPUT = 1024 * 1024;
const PROGRESS_INTERVAL_MS = 100;
/** A disk image or installer the user never ran stops counting as a pending update after a week. */
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const cacheFile = join(app.getPath("userData"), "update-check.json");
const pendingFile = join(app.getPath("userData"), "update-pending.json");

const METHODS = ["brew", "dmg", "nsis", "manual"] as const satisfies readonly AppInstallMethod[];

/**
 * Development-only stand-in for GitHub and the installers (`VOMP_UPDATE_FEED=/path/feed.json`,
 * ignored in packaged builds). `releases` uses the GitHub API shape; the other fields simulate the
 * install method, the brew run, the version brew leaves on disk, and omp's update check and run,
 * so every update state can be exercised without publishing a release or touching real installs.
 */
const DevFeed = z.object({
	releases: GitHubReleaseList,
	method: z.enum(METHODS).optional(),
	brewCommand: z.string().optional(),
	installedVersion: z.string().nullable().optional(),
	ompCheck: z
		.object({ code: z.number().default(0), stdout: z.string().default(""), stderr: z.string().default("") })
		.optional(),
	ompUpdateCommand: z.string().optional(),
	/** Version the simulated `omp update` reports afterwards (the real `omp --version` otherwise). */
	ompVersionAfter: z.string().optional(),
});
type DevFeed = z.infer<typeof DevFeed>;

const SIMULATED_BREW_COMMAND =
	"printf '==> Simulated brew upgrade --cask visual-omp (VOMP_UPDATE_FEED)\\n'; sleep 2; printf 'visual-omp was successfully upgraded.\\n'";

const devFeedFile = app.isPackaged ? undefined : process.env.VOMP_UPDATE_FEED;

/** Packaged builds accept only this release's GitHub installer; development feeds may use any host. */
const trust: InstallerTrust = { platform: process.platform as Platform, arch: process.arch, anyHost: devFeedFile !== undefined };

/** Re-read on every use so edits to the feed file apply without restarting. */
async function devFeed(): Promise<DevFeed | null> {
	if (!devFeedFile) return null;
	const parsed = DevFeed.safeParse(JSON.parse(await readFile(devFeedFile, "utf8")));
	if (!parsed.success) throw new Error(`VOMP_UPDATE_FEED is not a valid feed: ${z.prettifyError(parsed.error)}`);
	return parsed.data;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

let appStatus: AppUpdateStatus | null = null;
let appCheckInFlight: Promise<AppUpdateStatus> | null = null;

async function loadAppCache(): Promise<AppUpdateStatus | null> {
	if (devFeedFile) return null;
	try {
		return trustedCachedStatus(JSON.parse(await readFile(cacheFile, "utf8")), app.getVersion(), trust);
	} catch {
		return null;
	}
}

async function fetchReleases(currentVersion: string): Promise<GitHubRelease[]> {
	const feed = await devFeed();
	if (feed) return feed.releases;
	const env = await userEnv();
	const token = env.GITHUB_TOKEN || env.GH_TOKEN;
	const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": `visual-omp/${currentVersion}`,
			"X-GitHub-Api-Version": "2022-11-28",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		const limited = response.status === 403 || response.status === 429;
		throw new Error(
			limited ? "GitHub rate limit reached. Try again later." : `GitHub answered ${response.status} ${response.statusText}`.trim(),
		);
	}
	const parsed = GitHubReleaseList.safeParse(await response.json());
	if (!parsed.success) throw new Error("GitHub sent release data in a format visual-omp can't read.");
	return parsed.data;
}

async function fetchAppStatus(previous: AppUpdateStatus | null): Promise<AppUpdateStatus> {
	const currentVersion = app.getVersion();
	try {
		const release = selectLatestRelease(await fetchReleases(currentVersion), currentVersion);
		const assets = release ? toAssets(release) : [];
		const latestVersion = release ? release.tag_name.replace(/^v/, "") : null;
		const status: AppUpdateStatus = {
			currentVersion,
			latestVersion,
			updateAvailable: latestVersion !== null && compareSemver(latestVersion, currentVersion) > 0,
			tag: release?.tag_name ?? null,
			releaseName: release?.name || null,
			notes: release?.body || null,
			releaseUrl: release?.html_url ?? null,
			publishedAt: release?.published_at ? Date.parse(release.published_at) : null,
			assets,
			platformAsset: release ? installerAsset(assets, release.tag_name, trust) : null,
			summary: releaseSummary(release?.body ?? null),
			checkedAt: Date.now(),
			fromCache: false,
			error: null,
		};
		if (!devFeedFile) await writeText(cacheFile, JSON.stringify(status, null, 2));
		return status;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const base: AppUpdateStatus = previous ?? {
			currentVersion,
			latestVersion: null,
			updateAvailable: false,
			tag: null,
			releaseName: null,
			notes: null,
			releaseUrl: null,
			publishedAt: null,
			assets: [],
			platformAsset: null,
			summary: null,
			checkedAt: 0,
			fromCache: false,
			error: null,
		};
		return { ...base, fromCache: false, error: message };
	}
}

async function checkApp(force: boolean): Promise<AppUpdateStatus> {
	appStatus ??= await loadAppCache();
	if (!force && appStatus && appStatus.error === null && Date.now() - appStatus.checkedAt < CACHE_MS) {
		return { ...appStatus, fromCache: true };
	}
	appCheckInFlight ??= fetchAppStatus(appStatus)
		.then(status => {
			appStatus = status;
			broadcast("updates:app", status);
			return status;
		})
		.finally(() => {
			appCheckInFlight = null;
		});
	return appCheckInFlight;
}

let installCache: Promise<AppInstallInfo> | null = null;

/** Resolved targets of the `.app` links brew keeps in each installed version of the cask. */
async function caskApps(brew: string): Promise<string[]> {
	const room = caskroomPath(brew);
	const apps: string[] = [];
	for (const version of await readdir(room).catch(() => [])) {
		if (version.startsWith(".")) continue;
		for (const entry of await readdir(join(room, version)).catch(() => [])) {
			if (!entry.endsWith(".app")) continue;
			const target = await realpath(join(room, version, entry)).catch(() => null);
			if (target) apps.push(target);
		}
	}
	return apps;
}

async function detectInstall(): Promise<AppInstallInfo> {
	const feed = await devFeed().catch(() => null);
	const platform = process.platform as Platform;
	const appPath = platform === "darwin" ? appBundlePath(process.execPath) : null;
	const bundle = appPath ? await realpath(appPath).catch(() => appPath) : null;
	let brew: string | null = null;
	if (platform === "darwin" && bundle) {
		const env = await userEnv();
		for (const candidate of brewCandidates(env.PATH ?? "", homedir())) {
			if ((await exists(candidate)) && (await caskApps(candidate)).includes(bundle)) {
				brew = candidate;
				break;
			}
		}
	}
	const method =
		feed?.method ?? detectInstallMethod({ platform, isPackaged: app.isPackaged, bundle, caskApps: brew && bundle ? [bundle] : [] });
	let command: string | null = null;
	if (method === "brew") command = feed ? (feed.brewCommand ?? SIMULATED_BREW_COMMAND) : brewUpgradeCommand(brew ?? "brew");
	return { method, appPath, command };
}

/** Packaged builds detect once; development builds re-read the feed so its `method` can change. */
function installInfo(): Promise<AppInstallInfo> {
	if (devFeedFile) return detectInstall();
	installCache ??= detectInstall();
	return installCache;
}

/** Version of the `.app` on disk, which differs from the running one once brew has replaced it. */
async function installedVersion(): Promise<string | null> {
	const feed = await devFeed().catch(() => null);
	if (feed && feed.installedVersion !== undefined) return feed.installedVersion;
	const bundle = appBundlePath(process.execPath);
	if (!bundle) return null;
	try {
		return plistVersion(await readFile(join(bundle, "Contents", "Info.plist"), "utf8"));
	} catch {
		return null;
	}
}

let download: AppDownload | null = null;
let downloadAbort: AbortController | null = null;

function publishDownload(): void {
	if (download) broadcast("updates:app:download", { ...download });
}

async function startDownload(): Promise<AppDownload> {
	const status = appStatus ?? (await checkApp(false));
	const version = status.latestVersion;
	// Re-derived from the release metadata rather than taken from `platformAsset` as stored.
	const asset = status.tag ? installerAsset(status.assets, status.tag, trust) : null;
	if (!status.updateAvailable || !version || !asset) throw new Error("This release has no installer for this computer.");
	if (download?.version === version) {
		if (download.state === "downloading") return { ...download };
		if (download.state === "done" && (await exists(download.filePath))) return { ...download };
	}
	const url = new URL(asset.url);
	const fileName = basename(asset.name);
	const filePath = join(app.getPath("downloads"), fileName);
	const current: AppDownload = { version, fileName, filePath, received: 0, total: asset.size || null, state: "downloading", error: null };
	const abort = new AbortController();
	download = current;
	downloadAbort = abort;
	void receive(url, current, abort.signal);
	return { ...current };
}

async function receive(url: URL, current: AppDownload, signal: AbortSignal): Promise<void> {
	const partPath = `${current.filePath}.download`;
	let file: FileHandle | null = null;
	let lastEmit = 0;
	try {
		const response = await fetchInstaller(url, { signal, headers: { "User-Agent": `visual-omp/${app.getVersion()}` }, anyHost: trust.anyHost });
		if (!response.ok || !response.body) throw new Error(`The server answered ${response.status} ${response.statusText}`.trim());
		const length = Number(response.headers.get("content-length"));
		if (length > 0) current.total = length;
		file = await open(partPath, "w");
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			await file.write(value);
			current.received += value.byteLength;
			if (download === current && Date.now() - lastEmit >= PROGRESS_INTERVAL_MS) {
				lastEmit = Date.now();
				publishDownload();
			}
		}
		await file.close();
		file = null;
		await rename(partPath, current.filePath);
		current.state = "done";
	} catch (error) {
		await file?.close().catch(() => {});
		await rm(partPath, { force: true });
		if (signal.aborted) current.state = "cancelled";
		else Object.assign(current, { state: "failed", error: error instanceof Error ? error.message : String(error) });
	}
	if (download === current) {
		downloadAbort = null;
		publishDownload();
	}
}

const PendingSchema = z.object({ method: z.enum(METHODS), from: z.string(), to: z.string(), at: z.number() });

/** Remembers what the next launch should be, so it can report whether the update took. */
async function recordPending(method: AppInstallMethod, to: string): Promise<void> {
	await writeText(pendingFile, JSON.stringify({ method, from: app.getVersion(), to, at: Date.now() } satisfies z.infer<typeof PendingSchema>));
}

async function consumeOutcome(): Promise<AppUpdateOutcome | null> {
	let pending: z.infer<typeof PendingSchema>;
	try {
		pending = PendingSchema.parse(JSON.parse(await readFile(pendingFile, "utf8")));
	} catch {
		return null;
	}
	const running = app.getVersion();
	const updated = compareSemver(running, pending.from) > 0;
	const expired = Date.now() - pending.at > PENDING_TTL_MS;
	// A disk image or installer the user hasn't run yet is not a failure: stay quiet until it runs.
	if (!updated && pending.method !== "brew" && !expired) return null;
	await rm(pendingFile, { force: true });
	if (!updated && expired) return null;
	return { method: pending.method, from: pending.from, to: pending.to, running, updated };
}

async function runInstaller(): Promise<void> {
	if (download?.state !== "done") throw new Error("The installer hasn't finished downloading.");
	const failure = await shell.openPath(download.filePath);
	if (failure) throw new Error(failure);
	const { method } = await installInfo();
	await recordPending(method, download.version);
	// The NSIS installer can't replace files the running app holds open.
	if (method === "nsis" && app.isPackaged) setTimeout(() => app.quit(), 500);
}

/**
 * macOS: wait for this process to exit, then `open` the bundle path, so LaunchServices starts
 * whatever bundle is there now (the one brew just installed) instead of re-executing the old
 * binary, and the new instance never meets this one's single-instance lock.
 */
function relaunchAfterExit(): void {
	const bundle = appBundlePath(process.execPath);
	if (process.platform !== "darwin" || !bundle) {
		app.relaunch();
		return;
	}
	const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open "$0"';
	spawn("/bin/sh", ["-c", script, bundle, String(process.pid)], { detached: true, stdio: "ignore" }).unref();
}

async function quitApp(relaunch: boolean): Promise<void> {
	if (!app.isPackaged) throw new Error("Development builds don't restart themselves. Quit npm run dev and start it again.");
	const { method } = await installInfo();
	const to = (method === "brew" ? await installedVersion() : null) ?? download?.version ?? appStatus?.latestVersion;
	if (to) await recordPending(method, to);
	if (relaunch) app.once("will-quit", relaunchAfterExit);
	app.quit();
}

let ompCheck: OmpUpdateStatus | null = null;
let ompCheckInFlight: Promise<OmpUpdateStatus> | null = null;

async function runOmpCheck(): Promise<OmpUpdateStatus> {
	const checkedAt = Date.now();
	try {
		const simulated: CliResult | undefined = (await devFeed().catch(() => null))?.ompCheck;
		const parsed = parseOmpUpdateCheck(simulated ?? (await runOmp(["update", "--check"], { timeoutMs: 60_000 })));
		return { ...parsed, checkedAt, fromCache: false };
	} catch (error) {
		// runOmp rejects only when omp itself cannot be located.
		return {
			currentVersion: null,
			latestVersion: null,
			updateAvailable: false,
			channel: "stable",
			packageMovedTo: null,
			checkedAt,
			fromCache: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function checkOmp(force: boolean): Promise<OmpUpdateStatus> {
	if (!force && ompCheck && ompCheck.error === null && Date.now() - ompCheck.checkedAt < CACHE_MS) {
		return { ...ompCheck, fromCache: true };
	}
	ompCheckInFlight ??= runOmpCheck()
		.then(status => {
			ompCheck = status;
			broadcast("updates:omp", status);
			return status;
		})
		.finally(() => {
			ompCheckInFlight = null;
		});
	return ompCheckInFlight;
}

let lastRun: OmpUpdateRun | null = null;
/** Set synchronously on the first request, so requests that arrive while omp is being located share one run. */
let ompRunStarting: Promise<OmpUpdateRun> | null = null;

/** Not `async`: the running/starting checks and the reservation happen before anything awaits. */
function startOmpUpdate(options: OmpUpdateOptions = {}): Promise<OmpUpdateRun> {
	if (lastRun && lastRun.finishedAt === null) return Promise.resolve({ ...lastRun });
	ompRunStarting ??= spawnOmpUpdate(options).finally(() => {
		ompRunStarting = null;
	});
	return ompRunStarting;
}

async function spawnOmpUpdate(options: OmpUpdateOptions): Promise<OmpUpdateRun> {
	const args = ["update", ...(options.plugins ? ["--plugins"] : []), ...(options.force ? ["--force"] : [])];
	const [bin, env, feed] = await Promise.all([ompPath(), userEnv(), devFeed().catch(() => null)]);
	const run: OmpUpdateRun = {
		runId: randomUUID(),
		args,
		startedAt: Date.now(),
		finishedAt: null,
		exitCode: null,
		output: "",
		versionAfter: null,
	};
	lastRun = run;
	const [file, argv]: [string, string[]] = feed?.ompUpdateCommand ? ["/bin/sh", ["-c", feed.ompUpdateCommand]] : [bin, args];
	const child = spawn(file, argv, {
		env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
		const data = chunk.toString("utf8");
		if (run.output.length < MAX_RUN_OUTPUT) run.output += data;
		broadcast("updates:omp:output", { runId: run.runId, stream, data });
	};
	child.stdout.on("data", onData("stdout"));
	child.stderr.on("data", onData("stderr"));
	const finish = async (code: number, extra?: string) => {
		if (run.finishedAt !== null) return;
		if (extra) {
			run.output += extra;
			broadcast("updates:omp:output", { runId: run.runId, stream: "stderr", data: extra });
		}
		const status = await ompStatus(true);
		ompCheck = null;
		run.exitCode = code;
		run.versionAfter = feed?.ompVersionAfter ?? status.version;
		run.finishedAt = Date.now();
		broadcast("updates:omp:finished", { ...run });
		void checkOmp(true);
	};
	child.on("error", error => void finish(1, `${error.message}\n`));
	child.on("close", code => void finish(code ?? 1));
	return { ...run };
}

export function register(): void {
	handle("updates:app:check", force => checkApp(force === true));
	handle("updates:app:install", () => installInfo());
	handle("updates:app:download", () => startDownload());
	handle("updates:app:cancelDownload", () => downloadAbort?.abort());
	handle("updates:app:runInstaller", () => runInstaller());
	handle("updates:app:installedVersion", async () => {
		const version = await installedVersion();
		return { version, newer: version !== null && compareSemver(version, app.getVersion()) > 0 };
	});
	handle("updates:app:quit", relaunch => quitApp(relaunch));
	handle("updates:app:outcome", () => consumeOutcome());
	handle("updates:omp:check", force => checkOmp(force === true));
	handle("updates:omp:run", options => startOmpUpdate(options));
	handle("updates:omp:lastRun", () => (lastRun ? { ...lastRun } : null));

	// Fresh results are broadcast by the checks themselves; cached ones are sent here so a window
	// that just opened still learns about an update found earlier.
	const scheduledCheck = async () => {
		const [appResult, ompResult] = await Promise.all([checkApp(false), checkOmp(false)]);
		if (appResult.fromCache) broadcast("updates:app", appResult);
		if (ompResult.fromCache) broadcast("updates:omp", ompResult);
	};
	setTimeout(
		() => {
			void scheduledCheck();
			setInterval(() => void scheduledCheck(), CACHE_MS).unref();
		},
		devFeedFile ? 3000 : FIRST_CHECK_DELAY_MS,
	).unref();
}
