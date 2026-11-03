import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, nativeImage, shell } from "electron";
import { z } from "zod";
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

const BtwScope = z.object({ generation: z.number().int(), epoch: z.number().int() }).strict();
const BtwTopic = z.object({ id: z.string().min(1), scope: z.string().min(1).optional() }).strict();

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
	handle("host:stop", (hostId, mode) => stopHost(hostId, mode));
	handle("host:write", (hostId, data) => getHost(hostId).write(data));
	handle("host:paste", (hostId, text) => getHost(hostId).paste(text));
	handle("host:submit", (hostId, text, mode, imagePaths) => getHost(hostId).submit(text, mode, imagePaths));
	handle("host:prepare-restart", (hostId, generation, epoch) => getHost(hostId).prepareRestart(generation, epoch));
	handle("host:keys", (hostId, keys, generation, epoch) => getHost(hostId).keys(keys, generation, epoch));
	handle("host:retry-editor-restore", (hostId, id) => getHost(hostId).retryEditorRestore(id));
	handle("host:ack-editor-restore", (hostId, id) => getHost(hostId).ackEditorRestore(id));
	handle("host:take-editor-restore", (hostId, generation, epoch, sf, id, text) => getHost(hostId).takeEditorRestore(generation, epoch, sf, id, text));
	handle("host:tsp-tree-activate", (hostId, generation, epoch, sf, id, entryId) => getHost(hostId).tspTreeActivate(generation, epoch, sf, id, entryId));
	handle("host:screen", hostId => getHost(hostId).screenLines());
	handle("host:tui-focus", hostId => getHost(hostId).tuiFocus());
	handle("host:statusUnreadable", (hostId, border) => getHost(hostId).reportUnreadableStatus(border));
	handle("host:resize", (hostId, cols, rows) => getHost(hostId).resize(cols, rows));
	handle("host:buffer", hostId => getHost(hostId).serializedScreen());
	handle("host:tsp-snapshot", hostId => getHost(hostId).tspSnapshot());
	handle("host:tsp-event", (hostId, generation, event, epoch) => {
		if (!Number.isInteger(epoch)) throw new Error("TSP preview: A current protocol epoch is required.");
		return getHost(hostId).tspEvent(generation, event, epoch);
	});
	handle("host:tsp-answer", (hostId, generation, answer, epoch) => {
		if (!Number.isInteger(epoch)) throw new Error("TSP preview: A current protocol epoch is required.");
		return getHost(hostId).tspAnswer(generation, answer, epoch);
	});
	handle("host:tsp-advisor", (hostId, generation, action, epoch) => {
		if (!Number.isInteger(epoch)) throw new Error("TSP preview: A current protocol epoch is required.");
		return getHost(hostId).tspAdvisor(generation, action, epoch);
	});
	handle("host:tsp-resize", (hostId, cols) => getHost(hostId).tspResize(cols));
	handle("host:tsp-questions", (hostId, state) => getHost(hostId).tspQuestions(state));
	handle("host:list", () => listHosts());
	handle("btw:list", hostId => getHost(hostId).btwList());
	handle("btw:select", (hostId, topic, scope) => getHost(hostId).btwAction("select", "", BtwTopic.parse(topic), BtwScope.parse(scope)));
	handle("btw:ask", (hostId, question, scope) => getHost(hostId).btwAction("ask", z.string().parse(question), undefined, BtwScope.parse(scope)));
	handle("btw:followUp", (hostId, topic, text, scope) => getHost(hostId).btwAction("followUp", z.string().min(1).parse(text), BtwTopic.parse(topic), BtwScope.parse(scope)));
	handle("btw:stop", (hostId, topic, scope) => getHost(hostId).btwAction("stop", "", BtwTopic.parse(topic), BtwScope.parse(scope)));
	handle("btw:close", (hostId, topic, scope) => getHost(hostId).btwAction("close", "", BtwTopic.nullable().parse(topic), BtwScope.parse(scope)));
	handle("btw:inject", (hostId, topic, scope) => getHost(hostId).btwAction("inject", "", BtwTopic.parse(topic), BtwScope.parse(scope)));

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
