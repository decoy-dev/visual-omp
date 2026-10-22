import "./profile";
import { join } from "node:path";
import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { attachAttentionWindow, setAppUserModelId } from "./attention";
import { registerHandlers } from "./handlers";
import { ensureNewUserApproval } from "./features/config";
import { broadcast } from "./ipc";
import { buildMenu } from "./menu";
import { listHosts, stopAllHosts } from "./omp/host";
import { followSessions } from "./omp/follow";
import { stopWatchingSessions, watchSessions } from "./omp/sessions";
import { getPrefs } from "./prefs";
import { quitAction } from "./quitFlow";
import { killAllTerminals } from "./terminals";

let mainWindow: BrowserWindow | null = null;
/** Set once the renderer confirmed (or had nothing running) so the next quit proceeds. */
let quitApproved = false;
let quitting = false;
/** A quit came while no window was open and omp was still running: the reopened window asks once it has loaded. */
let askOnLoad = false;

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
		// The ink chrome (--chrome-bg in theme/tokens.css, as Chromium renders the OKLCH values), which frames the window
		// in both themes, so the first frame matches the frame instead of flashing.
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#080b0b" : "#141919",
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
	attachAttentionWindow(mainWindow);
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
	mainWindow.webContents.on("did-finish-load", () => {
		if (!askOnLoad) return;
		askOnLoad = false;
		broadcast("app:quitRequested", { reason: "quit" });
	});
	mainWindow.on("close", event => {
		if (quitApproved || process.platform === "darwin") return;
		event.preventDefault();
		broadcast("app:quitRequested", { reason: "close" });
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
		// A window reopened to ask that closes before it loaded asks nothing; the next quit reopens it again.
		askOnLoad = false;
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

setAppUserModelId();
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
	// Starts the check early; host:start and config:approval wait for it on a fresh profile.
	void ensureNewUserApproval();
	void watchSessions();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

/** Ask the renderer first: it knows whether any chat is still working and shows the warning (`quitAction`). */
app.on("before-quit", event => {
	const action = quitAction({
		approved: quitApproved,
		hasWindow: mainWindow !== null,
		ompRunning: listHosts().some(host => host.phase !== "exited"),
		reopening: askOnLoad,
	});
	if (action === "proceed") return;
	event.preventDefault();
	if (action === "ask") broadcast("app:quitRequested", { reason: "quit" });
	else if (action === "reopen") {
		askOnLoad = true;
		createWindow();
	}
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") void shutdown();
});
