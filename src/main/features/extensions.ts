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
import { type ChatTranscripts, dayStarts, type ParsedTranscript, parseTranscript, summarizeSpend } from "./extensions/spend";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
/** Subagents can spawn subagents; their transcripts nest one folder per level. */
const MAX_SUBAGENT_DEPTH = 4;
/** omp's `omp stats` default dashboard address. */
const STATS_PORT = 3847;
const STATS_URL = `http://127.0.0.1:${STATS_PORT}`;
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

let spendInFlight: { days: number; promise: Promise<SpendSummary> } | null = null;

let statsServer: ChildProcess | null = null;

async function statsReachable(): Promise<boolean> {
	try {
		const response = await fetch(STATS_URL, { signal: AbortSignal.timeout(1500) });
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * `omp stats` serves the dashboard until killed and opens the browser itself once it is up, so a
 * fresh start only waits for its "Dashboard available at" line; a running one is simply opened.
 */
async function openStatsDashboard(): Promise<string> {
	if (await statsReachable()) {
		await shell.openExternal(STATS_URL);
		return STATS_URL;
	}
	statsServer?.kill();
	const [bin, env] = await Promise.all([ompPath(), userEnv()]);
	const child = spawn(bin, ["stats", "--port", String(STATS_PORT)], {
		env: { ...env, NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	statsServer = child;
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let output = "";
	const timer = setTimeout(() => reject(new Error("omp's stats page took too long to start.")), STATS_START_TIMEOUT_MS);
	const onData = (chunk: Buffer) => {
		output += chunk.toString("utf8");
		const match = /Dashboard available at:\s*(\S+)/.exec(output);
		if (match?.[1]) resolve(match[1]);
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	child.once("error", reject);
	child.once("exit", code => {
		if (statsServer === child) statsServer = null;
		reject(new Error(output.trim().split("\n").pop() || `omp stats exited with ${code}`));
	});
	try {
		return await promise;
	} finally {
		clearTimeout(timer);
	}
}

export function register(): void {
	handle("extensions:spend", (days = DEFAULT_DAYS) => {
		const count = Math.min(MAX_DAYS, Math.max(1, Math.round(days)));
		// The status bar and the dashboard ask at the same time on open; share one scan per range.
		if (spendInFlight?.days === count) return spendInFlight.promise;
		const promise = computeSpend(count).finally(() => {
			if (spendInFlight?.promise === promise) spendInFlight = null;
		});
		spendInFlight = { days: count, promise };
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
		statsServer = null;
	});
}
