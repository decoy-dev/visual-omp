import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, nativeImage, shell } from "electron";
import type { Platform } from "@shared/ipc";
import { defaultChatFolder } from "@shared/chatFolder";
import fileLabels from "../shared/i18n/en/fileActions.json";
import { registerAttention } from "./attention";
import { listDir, pathExists, projectFiles, readText, writeText } from "./files";
import { handle } from "./ipc";
import { runOmp } from "./omp/cli";
import { getHost, listHosts, startHost, stopHost } from "./omp/host";
import { ompStatus } from "./omp/locate";
import { findSessionFile, listProjects, listSessions, readSessionFile, recentSessions } from "./omp/sessions";
import { sessionOwnership } from "./omp/elsewhere";
import { followSessions } from "./omp/follow";
import { trashSessionConversation } from "./omp/session-trash";
import { getPrefs, setPrefs } from "./prefs";
import { gateHostStart } from "./services/approval-default";
import { ensureNewUserApproval } from "./features/config";
import { killTerminal, resizeTerminal, startTerminal, writeTerminal } from "./terminals";
import { contextImageBytes } from "./services/contextImages";
import { openFile, showItem } from "./fileActions";

/** Only web links leave the app; everything else would let content launch local programs. */
function isSafeExternalUrl(url: string): boolean {
	return /^(https?|mailto):/i.test(url);
}

interface FeatureModule {
	register(): void;
}

/** Feature handler modules (`src/main/features/*.ts`), each registering its own IPC channels. Tests beside them stay out of the bundle. */
const features = import.meta.glob<FeatureModule>(["./features/*.ts", "!./features/*.test.ts"], { eager: true });

export function registerHandlers(onQuitDecision: (allow: boolean) => void): void {
	for (const feature of Object.values(features)) feature.register();
	handle("app:info", () => ({
		version: app.getVersion(),
		platform: process.platform as Platform,
		arch: process.arch,
		homeDir: homedir(),
		defaultChatFolder: defaultChatFolder(process.platform as Platform, tmpdir()),
	}));
	handle("app:prefs:get", () => getPrefs());
	handle("app:prefs:set", patch => setPrefs(patch));
	handle("app:openExternal", async url => {
		if (isSafeExternalUrl(url)) await shell.openExternal(url);
	});
	handle("app:showItem", showItem);
	handle("app:openFile", openFile);
	handle("app:copyImage", async dataUrl => {
		const image = nativeImage.createFromBuffer(contextImageBytes(dataUrl));
		if (image.isEmpty()) throw new Error("Couldn't decode the image");
		await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]);
	});
	handle("app:saveImage", async options => {
		if (!options || typeof options.name !== "string" || typeof options.title !== "string") throw new Error("Invalid image save options");
		const image = nativeImage.createFromBuffer(contextImageBytes(options.dataUrl));
		if (image.isEmpty()) throw new Error("Couldn't decode the image");
		const win = BrowserWindow.getFocusedWindow();
		const save: Electron.SaveDialogOptions = {
			title: options.title.slice(0, 200), defaultPath: basename(options.name).replace(/[\\/:]/g, "_").slice(0, 200) || "image.png",
			filters: [{ name: fileLabels.png, extensions: ["png"] }],
		};
		const result = win ? await dialog.showSaveDialog(win, save) : await dialog.showSaveDialog(save);
		if (result.canceled || !result.filePath) return null;
		await writeFile(result.filePath, image.toPNG());
		return result.filePath;
	});
	handle("app:pickFolder", async title => {
		const win = BrowserWindow.getFocusedWindow();
		const options: Electron.OpenDialogOptions = { title, properties: ["openDirectory", "createDirectory"] };
		const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});
	registerAttention();
	handle("app:confirmQuit", allow => onQuitDecision(allow));

	handle("omp:status", refresh => ompStatus(refresh));
	handle("omp:cli", (argv, cwd) => runOmp(argv, { cwd }));

	handle("sessions:projects", () => listProjects());
	handle("sessions:list", cwd => listSessions(cwd));
	handle("sessions:recent", limit => recentSessions(limit));
	handle("sessions:read", file => readSessionFile(file));
	handle("sessions:find", sessionId => findSessionFile(sessionId));
	handle("sessions:trash", trashSessionConversation);
	handle("sessions:ownership", async file => (await sessionOwnership([file])).get(file) ?? "unknown");
	handle("sessions:follow", files => followSessions(files));

	// A fresh profile's chats wait for the "Ask me first" default (services/approval-default.ts).
	handle("host:start", gateHostStart(ensureNewUserApproval, startHost));
	handle("host:stop", hostId => stopHost(hostId));
	handle("host:write", (hostId, data) => getHost(hostId).write(data));
	handle("host:paste", (hostId, text) => getHost(hostId).paste(text));
	handle("host:submit", (hostId, text, mode) => getHost(hostId).submit(text, mode));
	handle("host:keys", (hostId, keys) => getHost(hostId).keys(keys));
	handle("host:screen", hostId => getHost(hostId).screenLines());
	handle("host:resize", (hostId, cols, rows) => getHost(hostId).resize(cols, rows));
	handle("host:buffer", hostId => getHost(hostId).serializedScreen());
	handle("host:list", () => listHosts());

	handle("term:start", options => startTerminal(options));
	handle("term:write", (termId, data) => writeTerminal(termId, data));
	handle("term:resize", (termId, cols, rows) => resizeTerminal(termId, cols, rows));
	handle("term:kill", termId => killTerminal(termId));

	handle("fs:list", dir => listDir(dir));
	handle("fs:read", file => readText(file));
	handle("fs:write", (file, content) => writeText(file, content));
	handle("fs:exists", path => pathExists(path));
	handle("fs:files", cwd => projectFiles(cwd));
}
