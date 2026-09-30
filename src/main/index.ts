import "./profile";
import { join } from "node:path";
import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { registerHandlers } from "./handlers";
import { broadcast } from "./ipc";
import { buildMenu } from "./menu";
import { stopAllHosts } from "./omp/host";
import { followSessions } from "./omp/follow";
import { stopWatchingSessions, watchSessions } from "./omp/sessions";
import { getPrefs } from "./prefs";
import { killAllTerminals } from "./terminals";

let mainWindow: BrowserWindow | null = null;
/** Set once the renderer confirmed (or had nothing running) so the next quit proceeds. */
let quitApproved = false;
let quitting = false;

function createWindow(): void {
	const isMac = process.platform === "darwin";
	nativeTheme.themeSource = getPrefs().theme;
	mainWindow = new BrowserWindow({
		width: 1440,
		height: 920,
		minWidth: 960,
		minHeight: 620,
		show: false,
		title: "visual-omp",
		// Matches --bg in theme/tokens.css (as Chromium renders the OKLCH values) so the first frame doesn't flash.
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d1110" : "#f4f7f7",
		titleBarStyle: isMac ? "hiddenInset" : "hidden",
		trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
		titleBarOverlay: isMac ? undefined : { height: 44, color: "#00000000", symbolColor: "#6c6c74" },
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			spellcheck: true,
		},
	});
	mainWindow.once("ready-to-show", () => mainWindow?.show());
	// Never navigate the app window away; open web links in the user's browser instead.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/i.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	mainWindow.webContents.on("will-navigate", (event, url) => {
		if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
	});
	// Followed files belong to the renderer's read-only tabs; a reload, crash or closed window drops them.
	mainWindow.webContents.on("did-start-navigation", details => {
		if (details.isMainFrame && !details.isSameDocument) followSessions([]);
	});
	mainWindow.webContents.on("render-process-gone", () => followSessions([]));
	mainWindow.on("close", event => {
		if (quitApproved || process.platform === "darwin") return;
		event.preventDefault();
		broadcast("app:quitRequested", { reason: "close" });
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
		followSessions([]);
	});
	if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

async function shutdown(): Promise<void> {
	if (quitting) return;
	quitting = true;
	stopWatchingSessions();
	followSessions([]);
	killAllTerminals();
	await stopAllHosts();
	app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();

app.on("second-instance", () => {
	if (!mainWindow) return;
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.focus();
});

app.whenReady().then(() => {
	registerHandlers(allow => {
		if (!allow) return;
		quitApproved = true;
		void shutdown();
	});
	buildMenu();
	createWindow();
	void watchSessions();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

// Ask the renderer first: it knows whether any chat is still working and shows the warning.
app.on("before-quit", event => {
	if (quitApproved || !mainWindow) return;
	event.preventDefault();
	broadcast("app:quitRequested", { reason: "quit" });
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") void shutdown();
});
