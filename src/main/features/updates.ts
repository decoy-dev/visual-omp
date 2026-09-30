import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { app } from "electron";
import type { Platform } from "@shared/ipc";
import type { AppUpdateStatus, OmpUpdateOptions, OmpUpdateRun, OmpUpdateStatus } from "@shared/contracts/updates";
import { userEnv } from "../env";
import { writeText } from "../files";
import { broadcast, handle } from "../ipc";
import { runOmp } from "../omp/cli";
import { ompPath, ompStatus } from "../omp/locate";
import {
	GitHubReleaseList,
	compareSemver,
	parseOmpUpdateCheck,
	pickPlatformAsset,
	selectLatestRelease,
	toAssets,
	updateHint,
} from "../services/updates";

const REPO = "decoy-dev/visual-omp";
const CACHE_MS = 6 * 60 * 60 * 1000;
/** First background check shortly after launch, so startup is not slowed by the network. */
const FIRST_CHECK_DELAY_MS = 30_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_RUN_OUTPUT = 1024 * 1024;

const cacheFile = join(app.getPath("userData"), "update-check.json");

const ReleaseAssetSchema = z.object({ name: z.string(), url: z.string(), size: z.number() });
const AppUpdateStatusSchema = z.object({
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	updateAvailable: z.boolean(),
	tag: z.string().nullable(),
	releaseName: z.string().nullable(),
	notes: z.string().nullable(),
	releaseUrl: z.string().nullable(),
	publishedAt: z.number().nullable(),
	assets: z.array(ReleaseAssetSchema),
	platformAsset: ReleaseAssetSchema.nullable(),
	hint: z
		.discriminatedUnion("kind", [
			z.object({ kind: z.literal("command"), command: z.string(), url: z.string() }),
			z.object({ kind: z.literal("download"), url: z.string(), fileName: z.string() }),
			z.object({ kind: z.literal("page"), url: z.string() }),
		])
		.nullable(),
	checkedAt: z.number(),
	fromCache: z.boolean(),
	error: z.string().nullable(),
}) satisfies z.ZodType<AppUpdateStatus>;

let appStatus: AppUpdateStatus | null = null;
let appCheckInFlight: Promise<AppUpdateStatus> | null = null;

async function loadAppCache(): Promise<AppUpdateStatus | null> {
	try {
		const parsed = AppUpdateStatusSchema.safeParse(JSON.parse(await readFile(cacheFile, "utf8")));
		// A cache written by another app version compares against the wrong current version.
		return parsed.success && parsed.data.currentVersion === app.getVersion() ? parsed.data : null;
	} catch {
		return null;
	}
}

async function fetchAppStatus(previous: AppUpdateStatus | null): Promise<AppUpdateStatus> {
	const currentVersion = app.getVersion();
	const platform = process.platform as Platform;
	const env = await userEnv();
	const token = env.GITHUB_TOKEN || env.GH_TOKEN;
	try {
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
				limited
					? "GitHub rate limit reached. Try again later."
					: `GitHub answered ${response.status} ${response.statusText}`.trim(),
			);
		}
		const release = selectLatestRelease(GitHubReleaseList.parse(await response.json()), currentVersion);
		const assets = release ? toAssets(release) : [];
		const platformAsset = pickPlatformAsset(assets, platform, process.arch);
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
			platformAsset,
			hint: release ? updateHint(platform, release.html_url, platformAsset) : null,
			checkedAt: Date.now(),
			fromCache: false,
			error: null,
		};
		await writeText(cacheFile, JSON.stringify(status, null, 2));
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
			hint: null,
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

let ompCheck: OmpUpdateStatus | null = null;
let ompCheckInFlight: Promise<OmpUpdateStatus> | null = null;

async function runOmpCheck(): Promise<OmpUpdateStatus> {
	const checkedAt = Date.now();
	try {
		const parsed = parseOmpUpdateCheck(await runOmp(["update", "--check"], { timeoutMs: 60_000 }));
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
			return status;
		})
		.finally(() => {
			ompCheckInFlight = null;
		});
	return ompCheckInFlight;
}

let lastRun: OmpUpdateRun | null = null;

async function startOmpUpdate(options: OmpUpdateOptions = {}): Promise<OmpUpdateRun> {
	if (lastRun && lastRun.finishedAt === null) return { ...lastRun };
	const args = ["update", ...(options.plugins ? ["--plugins"] : []), ...(options.force ? ["--force"] : [])];
	const [bin, env] = await Promise.all([ompPath(), userEnv()]);
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
	const child = spawn(bin, args, {
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
		run.versionAfter = status.version;
		run.finishedAt = Date.now();
		broadcast("updates:omp:finished", { ...run });
	};
	child.on("error", error => void finish(1, `${error.message}\n`));
	child.on("close", code => void finish(code ?? 1));
	return { ...run };
}

export function register(): void {
	handle("updates:app:check", force => checkApp(force === true));
	handle("updates:omp:check", force => checkOmp(force === true));
	handle("updates:omp:run", options => startOmpUpdate(options));
	handle("updates:omp:lastRun", () => (lastRun ? { ...lastRun } : null));

	setTimeout(() => {
		void checkApp(false);
		setInterval(() => void checkApp(false), CACHE_MS).unref();
	}, FIRST_CHECK_DELAY_MS).unref();
}
