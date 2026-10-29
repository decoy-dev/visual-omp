import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import type { AnonymizedCopyResult, ImportSource, ShareFileResult, ShareLinkOptions, ShareLinkResult } from "@shared/contracts/share";
import { userEnv } from "../env";
import { handle } from "../ipc";
import { runOmp } from "../omp/cli";
import { allSessions, resolveSessionFile } from "../omp/sessions";
import { exportFileName, parseAnonymizeOutput, parseExportOutput, parseShareOutput, parseTransferOutput } from "../services/share";

const SHARE_TIMEOUT_MS = 180_000;
const EXPORT_TIMEOUT_MS = 180_000;

async function shareLink(sessionFile: string, options: ShareLinkOptions = {}): Promise<ShareLinkResult> {
	const file = await resolveSessionFile(sessionFile);
	const result = await runOmp(["share", file, ...(options.gist ? ["--gist"] : [])], {
		timeoutMs: SHARE_TIMEOUT_MS,
	});
	const parsed = result.code === 0 ? parseShareOutput(result.stdout) : null;
	if (!parsed) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `omp share exited with ${result.code}`);
	}
	return parsed;
}

async function askExportPath(sessionFile: string): Promise<string | null> {
	const session = (await allSessions()).find(summary => summary.file === sessionFile);
	const defaultPath = join(
		app.getPath("downloads"),
		exportFileName(session?.title ?? session?.preview ?? null, session?.id ?? basename(sessionFile, ".jsonl")),
	);
	const options: Electron.SaveDialogOptions = {
		title: "Export chat as HTML",
		defaultPath,
		filters: [{ name: "Web page", extensions: ["html"] }],
		properties: ["createDirectory", "showOverwriteConfirmation"],
	};
	const win = BrowserWindow.getFocusedWindow();
	const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
	return choice.canceled || !choice.filePath ? null : choice.filePath;
}

async function exportHtml(input: string, outputPath?: string): Promise<string | null> {
	const sessionFile = await resolveSessionFile(input);
	const target = outputPath ? resolve(outputPath) : await askExportPath(sessionFile);
	if (!target) return null;
	// `omp --export <session> <output>`: the first positional argument is the output path.
	const result = await runOmp(["--export", sessionFile, target], { timeoutMs: EXPORT_TIMEOUT_MS });
	const written = result.code === 0 ? parseExportOutput(result.stdout) : null;
	if (!written) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `omp --export exited with ${result.code}`);
	}
	return resolve(written);
}

async function askFolder(title: string): Promise<string | null> {
	const options: Electron.OpenDialogOptions = { title, properties: ["openDirectory", "createDirectory"] };
	const win = BrowserWindow.getFocusedWindow();
	const choice = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
	return choice.canceled ? null : choice.filePaths[0] ?? null;
}

async function pack(input: string): Promise<ShareFileResult | null> {
	const sessionFile = await resolveSessionFile(input);
	const options: Electron.SaveDialogOptions = {
		title: "Save chat for another computer",
		defaultPath: join(app.getPath("downloads"), `${basename(sessionFile, ".jsonl")}.tar`),
		filters: [{ name: "omp session archive", extensions: ["tar"] }],
		properties: ["createDirectory", "showOverwriteConfirmation"],
	};
	const win = BrowserWindow.getFocusedWindow();
	const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
	if (choice.canceled || !choice.filePath) return null;
	const result = await runOmp(["session", "pack", sessionFile, choice.filePath], { timeoutMs: EXPORT_TIMEOUT_MS });
	const path = result.code === 0 ? parseTransferOutput(result.stdout) : null;
	if (!path) throw new Error(result.stderr.trim() || result.stdout.trim() || `omp session pack exited with ${result.code}`);
	return { path, report: result.stderr.trim() };
}

async function unpack(): Promise<ShareFileResult | null> {
	const options: Electron.OpenDialogOptions = {
		title: "Import a chat from another computer",
		filters: [{ name: "omp session archive", extensions: ["tar"] }],
		properties: ["openFile"],
	};
	const win = BrowserWindow.getFocusedWindow();
	const choice = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
	const archive = choice.canceled ? null : choice.filePaths[0];
	if (!archive) return null;
	const cwd = await askFolder("Choose the project folder for this chat");
	if (!cwd) return null;
	const result = await runOmp(["session", "unpack", archive, "--cwd", cwd], { timeoutMs: EXPORT_TIMEOUT_MS });
	const path = result.code === 0 ? parseTransferOutput(result.stdout) : null;
	if (!path) throw new Error(result.stderr.trim() || result.stdout.trim() || `omp session unpack exited with ${result.code}`);
	return { path, report: result.stderr.trim() };
}

async function anonymize(input: string): Promise<AnonymizedCopyResult | null> {
	const sessionFile = await resolveSessionFile(input);
	const target = await askFolder("Choose a new or empty folder for the anonymized copy");
	if (!target) return null;
	const result = await runOmp(["anonymize", sessionFile, "-o", target], { timeoutMs: EXPORT_TIMEOUT_MS });
	const parsed = result.code === 0 ? parseAnonymizeOutput(result.stdout) : null;
	if (!parsed) throw new Error(result.stderr.trim() || result.stdout.trim() || `omp anonymize exited with ${result.code}`);
	return { ...parsed, report: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") };
}

/** `.jsonl` transcripts under `dir` (to `depth` levels of subfolders): count and newest mtime. */
async function scanTranscripts(dir: string, depth: number): Promise<{ count: number; newest: number }> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return { count: 0, newest: 0 };
	}
	let count = 0;
	let newest = 0;
	await Promise.all(
		entries.map(async entry => {
			const full = join(dir, entry.name);
			if (entry.isDirectory() && depth > 0) {
				const inner = await scanTranscripts(full, depth - 1);
				count += inner.count;
				newest = Math.max(newest, inner.newest);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				count++;
				newest = Math.max(newest, await stat(full).then(info => info.mtimeMs, () => 0));
			}
		}),
	);
	return { count, newest };
}

async function importSources(): Promise<ImportSource[]> {
	const env = await userEnv();
	const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() ? resolve(env.CLAUDE_CONFIG_DIR.trim()) : join(homedir(), ".claude");
	const codexDir = join(homedir(), ".codex");
	// Mirrors omp's ClaudeSessionStore (`projects/<encoded-cwd>/*.jsonl`, also `.projects`) and
	// CodexSessionStore rollout fallback (`sessions/YYYY/MM/DD/*.jsonl`, `.sessions`, `archived_sessions`).
	const [claude, codex] = await Promise.all([
		Promise.all(["projects", ".projects"].map(name => scanTranscripts(join(claudeDir, name), 1))),
		Promise.all(["sessions", ".sessions", "archived_sessions"].map(name => scanTranscripts(join(codexDir, name), 4))),
	]);
	const source = (
		id: ImportSource["id"],
		label: string,
		dataDir: string,
		scans: Array<{ count: number; newest: number }>,
	): ImportSource => {
		const sessionCount = scans.reduce((sum, scan) => sum + scan.count, 0);
		const newest = Math.max(0, ...scans.map(scan => scan.newest));
		return {
			id,
			label,
			dataDir,
			available: sessionCount > 0,
			sessionCount,
			lastModified: newest > 0 ? newest : null,
			launchArgs: [id === "claude" ? "--from-claude" : "--from-codex"],
		};
	};
	return [source("claude", "Claude Code", claudeDir, claude), source("codex", "Codex", codexDir, codex)];
}

export function register(): void {
	handle("share:link", (sessionFile, options) => shareLink(sessionFile, options));
	handle("share:exportHtml", (sessionFile, outputPath) => exportHtml(sessionFile, outputPath));
	handle("share:pack", sessionFile => pack(sessionFile));
	handle("share:unpack", () => unpack());
	handle("share:anonymize", sessionFile => anonymize(sessionFile));
	handle("share:importSources", () => importSources());
}
