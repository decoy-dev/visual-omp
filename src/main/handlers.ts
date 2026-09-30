import { homedir } from "node:os";
import { app, BrowserWindow, dialog, Notification, shell } from "electron";
import type { Platform } from "@shared/ipc";
import { listDir, pathExists, projectFiles, readText, writeText } from "./files";
import { handle } from "./ipc";
import { runOmp } from "./omp/cli";
import { getHost, listHosts, startHost, stopHost } from "./omp/host";
import { ompStatus } from "./omp/locate";
import { listProjects, listSessions, readSessionFile } from "./omp/sessions";
import { getPrefs, setPrefs } from "./prefs";
import { killTerminal, resizeTerminal, startTerminal, writeTerminal } from "./terminals";

/** Only web links leave the app; everything else would let content launch local programs. */
function isSafeExternalUrl(url: string): boolean {
	return /^(https?|mailto):/i.test(url);
}

export function registerHandlers(onQuitDecision: (allow: boolean) => void): void {
	handle("app:info", () => ({
		version: app.getVersion(),
		platform: process.platform as Platform,
		arch: process.arch,
		homeDir: homedir(),
	}));
	handle("app:prefs:get", () => getPrefs());
	handle("app:prefs:set", patch => setPrefs(patch));
	handle("app:openExternal", async url => {
		if (isSafeExternalUrl(url)) await shell.openExternal(url);
	});
	handle("app:showItem", path => shell.showItemInFolder(path));
	handle("app:pickFolder", async title => {
		const win = BrowserWindow.getFocusedWindow();
		const options: Electron.OpenDialogOptions = { title, properties: ["openDirectory", "createDirectory"] };
		const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});
	handle("app:notify", (title, body) => {
		if (getPrefs().notifications && Notification.isSupported()) new Notification({ title, body }).show();
	});
	handle("app:confirmQuit", allow => onQuitDecision(allow));

	handle("omp:status", refresh => ompStatus(refresh));
	handle("omp:cli", (argv, cwd) => runOmp(argv, { cwd }));

	handle("sessions:projects", () => listProjects());
	handle("sessions:list", cwd => listSessions(cwd));
	handle("sessions:read", file => readSessionFile(file));

	handle("host:start", options => startHost(options));
	handle("host:stop", hostId => stopHost(hostId));
	handle("host:write", (hostId, data) => getHost(hostId).write(data));
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
