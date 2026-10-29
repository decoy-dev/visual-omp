import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, nativeImage } from "electron";
import { z } from "zod";
import { broadcast, handle, onBroadcast } from "../ipc";
import type { SlashCommandInfo, SlashCommandListing } from "@shared/contracts/composer";
import { ompAgentDir } from "../omp/config-file";
import { getHost } from "../omp/host";
import { rpcRequest } from "../omp/rpc";
import { discoverCommands } from "../services/composer";
import { mergeSlashCommands, OMP_BUILTIN_COMMANDS } from "../services/omp-builtin-commands";
import { readPromptHistory } from "../services/prompt-history";
import { userEnv } from "../env";
import { agentDir } from "../omp/paths";
import { closePredictions, predictFeedback, predictWord, releasePredictionFolder, retainPredictionFolder } from "../omp/predict";
import { closeDictation, startDictation, stopDictation } from "../omp/dictation";
import { nativeBridge } from "../omp/native-bridge";
import { PredictionTransfers } from "../omp/prediction-transfer";

const THUMB_EDGE = 96;
const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/;
const predictionTransfers = new PredictionTransfers(getHost, nativeBridge, captures => broadcast("composer:predictionCaptures", captures));

// ─── Slash commands (`get_available_commands`) ─────────────────────────────

/** Skills, extensions, custom commands and MCP prompts stay on: they are what the listing is for. */
const SLASH_RPC_FLAGS = ["--no-session", "--no-lsp", "--no-title", "--no-rules"];
const SLASH_TIMEOUT_MS = 20_000;

const AvailableCommandSchema = z
	.object({
		name: z.string(),
		aliases: z.array(z.string()).optional(),
		description: z.string().optional(),
		input: z.object({ hint: z.string() }).loose().optional(),
		subcommands: z
			.array(z.object({ name: z.string(), description: z.string().optional(), usage: z.string().optional() }).loose())
			.optional(),
		source: z.enum(["builtin", "skill", "extension", "custom", "mcp_prompt", "file"]),
	})
	.loose();
/** Entries are checked one by one: a source a newer omp adds skips that entry, not the listing. */
const AvailableCommandsSchema = z.object({ commands: z.array(z.unknown()) });

async function readSlashCommands(folder: string): Promise<SlashCommandInfo[]> {
	const data = await rpcRequest(folder, "get_available_commands", {
		flags: SLASH_RPC_FLAGS,
		timeoutMs: SLASH_TIMEOUT_MS,
		messages: {
			timeout: "omp did not list its commands in time.",
			exited: "omp stopped before listing its commands.",
			failed: "omp did not list its commands.",
		},
	});
	const listed = AvailableCommandsSchema.parse(data).commands.flatMap(entry => {
		const parsed = AvailableCommandSchema.safeParse(entry);
		if (!parsed.success) return [];
		const command = parsed.data;
		return [
			{
				name: command.name,
				aliases: command.aliases ?? [],
				description: command.description ?? null,
				hint: command.input?.hint ?? null,
				subcommands: (command.subcommands ?? []).map(sub => ({ name: sub.name, description: sub.description ?? null, usage: sub.usage ?? null })),
				source: command.source,
			},
		];
	});
	return mergeSlashCommands(OMP_BUILTIN_COMMANDS, listed);
}

/** omp's answers per project folder; a failed listing is not kept, so the next request asks again. */
const slashCache = new Map<string, Promise<SlashCommandListing>>();

/** When omp can't be asked, the builtin catalog marked incomplete. `fresh` replaces a kept answer. */
function slashCommands(folder: string, fresh: boolean): Promise<SlashCommandListing> {
	const cached = slashCache.get(folder);
	if (cached && !fresh) return cached;
	const listing: Promise<SlashCommandListing> = readSlashCommands(folder).then(
		commands => ({ commands, complete: true }),
		() => {
			if (slashCache.get(folder) === listing) slashCache.delete(folder);
			return { commands: [...OMP_BUILTIN_COMMANDS], complete: false };
		},
	);
	slashCache.set(folder, listing);
	return listing;
}

/** Content-addressed so pasting the same image twice reuses one file. */
async function saveTemp(bytes: Uint8Array, extension: string): Promise<string> {
	const ext = extension.toLowerCase().replace(/^\./, "");
	if (!SAFE_EXTENSION.test(ext)) throw new Error(`Unsupported file type: ${extension}`);
	const dir = join(tmpdir(), "visual-omp", "pasted");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
	const file = join(dir, `pasted-image-${hash}.${ext}`);
	await writeFile(file, bytes, { mode: 0o600 });
	return file;
}

async function pickFiles(cwd: string): Promise<string[]> {
	const options: Electron.OpenDialogOptions = {
		title: "Attach files",
		defaultPath: cwd,
		properties: ["openFile", "multiSelections"],
	};
	const win = BrowserWindow.getFocusedWindow();
	const choice = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
	return choice.canceled ? [] : choice.filePaths;
}

async function thumbnail(path: string): Promise<string | null> {
	const image = await nativeImage.createThumbnailFromPath(path, { width: THUMB_EDGE, height: THUMB_EDGE }).catch(() =>
		nativeImage.createFromPath(path),
	);
	if (image.isEmpty()) return null;
	const { width, height } = image.getSize();
	const scale = THUMB_EDGE / Math.max(width, height);
	const sized = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : image;
	return sized.toDataURL();
}



/** Deliver omp's image-path attachment syntax without Enter; caller submits message text afterward. */
async function paste(hostId: string, text: string): Promise<void> {
	if (!text.trim()) throw new Error("Image attachment paths are required");
	await getHost(hostId).paste(text);
}

export function register(): void {
	handle("sessions:promptHistory", async sessionId => readPromptHistory(join(agentDir(await userEnv()), "history.db"), sessionId));
	handle("composer:saveTemp", (bytes, extension) => saveTemp(bytes, extension));
	handle("composer:pickFiles", cwd => pickFiles(cwd));
	handle("composer:thumbnail", path => thumbnail(path));
	handle("composer:commands", async cwd => discoverCommands(cwd, await ompAgentDir()));
	handle("composer:voiceStart", (cwd, id) => startDictation(cwd, id, update => broadcast("composer:dictation", update)));
	handle("composer:voiceStop", id => stopDictation(id));
	handle("composer:retainPredictions", (cwd, owner) => retainPredictionFolder(cwd, owner));
	handle("composer:releasePredictions", (cwd, owner) => releasePredictionFolder(cwd, owner));
	handle("composer:isSideCommand", async (hostId, name) => {
		if (OMP_BUILTIN_COMMANDS.some(command => command.name === name || command.aliases.includes(name))) return false;
		return (await nativeBridge(hostId).sideCommands()).includes(name);
	});
	handle("composer:predictWord", (cwd, text, cursor) => predictWord(cwd, text, cursor));
	handle("composer:predictFeedback", (cwd, text, cursor, suggestion, accepted) => predictFeedback(cwd, text, cursor, suggestion, accepted));
	handle("composer:tuiPrediction", hostId => predictionTransfers.offer(hostId));
	handle("composer:takePrediction", request => predictionTransfers.take(request));
	handle("composer:predictionCaptures", () => predictionTransfers.list());
	handle("composer:retryPrediction", id => predictionTransfers.retry(id));
	handle("composer:ackPrediction", id => predictionTransfers.acknowledge(id));
	handle("composer:paste", (hostId, text) => paste(hostId, text));
	handle("composer:slashCommands", (cwd, fresh) => slashCommands(cwd, fresh === true));
	// What omp lists depends on skills, plugins (extensions and commands), MCP servers (prompts),
	// providers (extension-backed ones) and config (`skills.enableSkillCommands`).
	for (const channel of ["skills:changed", "plugins:changed", "mcp:changed", "providers:changed", "config:changed"] as const) {
		onBroadcast(channel, () => slashCache.clear());
		if (channel === "config:changed") onBroadcast(channel, () => closePredictions());
	}
	const closeDraftProcesses = () => { closePredictions(true); closeDictation(true); };
	app.on("will-quit", closeDraftProcesses);
	app.on("window-all-closed", closeDraftProcesses);
}
