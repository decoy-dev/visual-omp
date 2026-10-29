import { type ChildProcess, spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import type { SpendSummary } from "@shared/contracts/extensions";
import { userEnv } from "../env";
import { handle } from "../ipc";
import { ompPath } from "../omp/locate";
import { sessionsDir } from "../omp/paths";
import { ompStartError } from "../omp/refused";
import { type ChatTranscripts, dayStarts, type ParsedTranscript, parseTranscript, summarizeSpend } from "./extensions/spend";

const DEFAULT_DAYS = 7;
/** The activity grid's year: 53 whole weeks (`ACTIVITY_DAYS` in the renderer's usage model). */
const MAX_DAYS = 371;
/** Subagents can spawn subagents; their transcripts nest one folder per level. */
const MAX_SUBAGENT_DEPTH = 4;
const STATS_START_TIMEOUT_MS = 60_000;

interface CachedTranscript {
	mtimeMs: number;
	size: number;
	parsed: ParsedTranscript;
}

const transcriptCache = new Map<string, CachedTranscript>();

async function listDir(dir: string): Promise<Dirent[]> {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** `.jsonl` files under a session's companion folder (subagent transcripts), recursively. */
async function subagentFiles(dir: string, depth: number): Promise<string[]> {
	if (depth > MAX_SUBAGENT_DEPTH) return [];
	const found: string[] = [];
	for (const entry of await listDir(dir)) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await subagentFiles(path, depth + 1)));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
	}
	return found;
}

type Load = { parsed: ParsedTranscript; stale: false } | { parsed: null; stale: boolean };

/** Parse a transcript unless it was last written before `since` (it can hold no calls in range). */
async function loadTranscript(file: string, since: number, seen: Set<string>): Promise<Load> {
	try {
		const info = await stat(file);
		seen.add(file);
		if (info.mtimeMs < since) return { parsed: null, stale: true };
		const hit = transcriptCache.get(file);
		if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return { parsed: hit.parsed, stale: false };
		const parsed = parseTranscript(await readFile(file, "utf8"));
		transcriptCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, parsed });
		return { parsed, stale: false };
	} catch {
		transcriptCache.delete(file);
		return { parsed: null, stale: false };
	}
}

async function computeSpend(dayCount: number): Promise<SpendSummary> {
	const now = Date.now();
	const since = dayStarts(now, dayCount)[0] ?? now;
	const root = sessionsDir(await userEnv());
	const seen = new Set<string>();
	const chats: ChatTranscripts[] = [];
	let skipped = 0;
	const buckets = (await listDir(root)).filter(entry => entry.isDirectory());
	await Promise.all(
		buckets.map(async bucket => {
			const bucketDir = join(root, bucket.name);
			const entries = await listDir(bucketDir);
			const folders = new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name));
			await Promise.all(
				entries
					.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
					.map(async entry => {
						const file = join(bucketDir, entry.name);
						const stem = entry.name.slice(0, -".jsonl".length);
						const subFiles = folders.has(stem) ? await subagentFiles(join(bucketDir, stem), 1) : [];
						const main = await loadTranscript(file, since, seen);
						const subs = await Promise.all(subFiles.map(sub => loadTranscript(sub, since, seen)));
						if (!main.parsed && !main.stale) skipped++;
						const subagents = subs.flatMap(sub => (sub.parsed ? [sub.parsed] : []));
						if (!main.parsed && subagents.length === 0) return;
						// A chat untouched in range can still have a subagent that finished inside it: keep its header.
						const header = main.parsed ?? (main.stale ? (await loadTranscript(file, 0, seen)).parsed : null);
						chats.push({ file, main: header ?? { header: null, calls: [] }, subagents });
					}),
			);
		}),
	);
	for (const file of transcriptCache.keys()) if (!seen.has(file)) transcriptCache.delete(file);
	return summarizeSpend(chats, now, dayCount, skipped);
}

/** Pending scans by range, queued ones included, so a range asked for again joins the scan already on its way. */
const spendInFlight = new Map<number, Promise<SpendSummary>>();
/**
 * Scans of different ranges run one after another: each parses only the transcripts the cache lacks, so a short
 * range asked for beside the year (Home asks for both) never parses the same files twice.
 */
let spendQueue: Promise<unknown> = Promise.resolve();

let statsServer: ChildProcess | null = null;
let statsUrl: string | null = null;
let statsStarting: Promise<string> | null = null;
let statsQuitting = false;

/** omp opens the browser on startup; only reopen a dashboard owned by this app. */
async function openStatsDashboard(): Promise<string> {
	if (statsQuitting) throw new Error("visual-omp is closing.");
	if (statsStarting) return statsStarting;
	if (statsServer && !statsServer.killed && statsServer.exitCode === null && statsServer.signalCode === null && statsUrl) {
		const url = statsUrl;
		await shell.openExternal(url);
		return url;
	}
	const pending = startStatsDashboard();
	statsStarting = pending;
	try {
		return await pending;
	} finally {
		if (statsStarting === pending) statsStarting = null;
	}
}

async function startStatsDashboard(): Promise<string> {
	const [bin, env] = await Promise.all([ompPath(), userEnv()]);
	if (statsQuitting) throw new Error("visual-omp is closing.");
	let child: ChildProcess;
	try {
		child = spawn(bin, ["stats"], {
			env: { ...env, NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		throw await ompStartError(error, bin);
	}
	statsServer = child;
	statsUrl = null;
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let output = "";
	let stdout = "";
	let stderr = "";
	let ready = false;
	const clearOwnedServer = () => {
		if (statsServer !== child) return;
		statsServer = null;
		statsUrl = null;
	};
	const stopReading = () => {
		clearTimeout(timer);
		child.stdout?.off("data", onStdout);
		child.stderr?.off("data", onStderr);
	};
	const fail = (error: Error) => {
		clearOwnedServer();
		stopReading();
		reject(error);
	};
	const onData = (text: string) => {
		const match = /Dashboard available at:[ \t]*([^\r\n]*)[\r\n]/.exec(text);
		if (!match) return;
		const printedUrl = match[1] ?? "";
		try {
			const url = new URL(printedUrl);
			// Reject authorities that URL would repair or normalize into a loopback address.
			const loopbackAuthority = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i;
			if (
				url.protocol !== "http:" ||
				(url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
				url.username || url.password ||
				!loopbackAuthority.test(printedUrl) ||
				/[\s\\]/.test(printedUrl)
			) {
				throw new Error("Invalid stats dashboard URL.");
			}
		} catch {
			fail(new Error("omp printed an invalid stats dashboard URL."));
			child.kill();
			return;
		}
		ready = true;
		statsUrl = printedUrl;
		stopReading();
		resolve(printedUrl);
	};
	const onStdout = (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		output += text;
		stdout += text;
		onData(stdout);
	};
	const onStderr = (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		output += text;
		stderr += text;
		onData(stderr);
	};
	const timer = setTimeout(() => {
		fail(new Error("omp's stats page took too long to start."));
		child.kill();
	}, STATS_START_TIMEOUT_MS);
	child.stdout?.on("data", onStdout);
	child.stderr?.on("data", onStderr);
	child.once("error", error => {
		fail(error);
		child.kill();
	});
	child.once("exit", code => {
		clearOwnedServer();
		stopReading();
		if (!ready) reject(new Error(output.trim().split("\n").pop() || `omp stats exited with ${code}`));
	});
	return promise;
}

export function register(): void {
	handle("extensions:spend", (days = DEFAULT_DAYS) => {
		const count = Math.min(MAX_DAYS, Math.max(1, Math.round(days)));
		// The status bar and the dashboard ask at the same time on open; share one scan per range.
		const pending = spendInFlight.get(count);
		if (pending) return pending;
		const promise = spendQueue
			.catch(() => undefined)
			.then(() => computeSpend(count))
			.finally(() => {
				if (spendInFlight.get(count) === promise) spendInFlight.delete(count);
			});
		spendQueue = promise;
		spendInFlight.set(count, promise);
		return promise;
	});

	handle("extensions:saveText", async ({ title, defaultName, content, filters }) => {
		const options: Electron.SaveDialogOptions = {
			title,
			defaultPath: join(app.getPath("downloads"), defaultName),
			filters,
			properties: ["createDirectory", "showOverwriteConfirmation"],
		};
		const win = BrowserWindow.getFocusedWindow();
		const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
		if (choice.canceled || !choice.filePath) return null;
		await writeFile(choice.filePath, content, "utf8");
		return choice.filePath;
	});

	handle("extensions:statsDashboard", () => openStatsDashboard());

	app.on("will-quit", () => {
		statsServer?.kill();
		statsUrl = null;
		statsQuitting = true;
		statsServer = null;
	});
}
