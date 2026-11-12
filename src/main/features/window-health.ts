import "@shared/contracts/window-health";
import { BrowserWindow, dialog, powerMonitor } from "electron";
import { handleWithEvent } from "../ipc";
import { hostBacklogs, onCollabResync } from "../omp/host";
import { HEARTBEAT_MS, WindowHealth } from "../services/window-health";

const FORM_TEXT = "Text entered in open omp forms may be lost.";

interface Watched {
	window: BrowserWindow;
	health: WindowHealth;
	seq: number;
	/** Counts pages loaded in the window, so a reload asked about one page never reloads the next. */
	page: number;
	/** The reload question on screen, shared by the palette, the warning and the frozen-window dialog. */
	asking: Promise<boolean> | null;
}

/** Each watched window, by its web contents id. */
const watched = new Map<number, Watched>();

function publish(entry: Watched): void {
	if (!entry.window.isDestroyed()) entry.window.webContents.send("window:health", entry.health.incident);
}

/** Ask before reloading the window, at most once at a time; reload the same page it was asked about if the person agrees. */
function confirmReload(entry: Watched, frozen: boolean): Promise<boolean> {
	entry.asking ??= (async () => {
		const page = entry.page;
		try {
			const { response } = await dialog.showMessageBox(entry.window, frozen
				? {
					type: "warning",
					message: "visual-omp is not responding",
					detail: `The window has not responded for 30 seconds. Reloading it reconnects your open chats. ${FORM_TEXT}`,
					buttons: ["Keep waiting", "Reload window"],
					defaultId: 0,
					cancelId: 0,
					noLink: true,
				}
				: {
					type: "question",
					message: "Reload window?",
					detail: `Open chats will reconnect. ${FORM_TEXT}`,
					buttons: ["Cancel", "Reload window"],
					defaultId: 0,
					cancelId: 0,
					noLink: true,
				});
			if (response !== 1 || entry.window.isDestroyed() || entry.page !== page) return false;
			if (entry.health.acted(Date.now())) publish(entry);
			entry.window.webContents.reload();
			return true;
		} catch {
			return false;
		} finally {
			entry.asking = null;
		}
	})();
	return entry.asking;
}

/**
 * Watch `window` for slowdowns: a heartbeat every two seconds (at most one unanswered), the bytes waiting to reach it
 * for each chat and the chats that had to resync. Heartbeats start when the page reports `window:ready`, and stop
 * while a new page loads. Changes go to the window as `window:health`; a window that stops answering for 30 seconds
 * gets one native dialog per slowdown. A hidden or minimized window is not judged, and sleep or showing the window
 * starts over.
 */
export function attachWindowHealth(window: BrowserWindow): void {
	const entry: Watched = { window, health: new WindowHealth(), seq: 0, page: 0, asking: null };
	const { health } = entry;
	const id = window.webContents.id;
	watched.set(id, entry);
	const restart = () => {
		const ended = health.incident !== null;
		health.reset(Date.now());
		if (ended) publish(entry);
	};
	const newPage = () => {
		entry.page++;
		const ended = health.incident !== null;
		health.pageLoading(Date.now());
		if (ended) publish(entry);
	};
	const stopResync = onCollabResync(chatId => health.resync(chatId, Date.now()));
	const timer = setInterval(() => {
		if (window.isDestroyed()) return;
		const now = Date.now();
		if (!window.isVisible() || window.isMinimized()) {
			restart();
			return;
		}
		if (health.heartbeatDue) {
			health.heartbeatSent(now);
			window.webContents.send("window:ping", ++entry.seq);
		}
		if (health.sample(now, hostBacklogs())) publish(entry);
		if (health.frozen(now)) void confirmReload(entry, true);
	}, HEARTBEAT_MS);
	timer.unref();
	window.on("show", restart);
	window.on("restore", restart);
	window.webContents.on("did-start-loading", newPage);
	window.webContents.on("render-process-gone", newPage);
	powerMonitor.on("resume", restart);
	window.once("closed", () => {
		clearInterval(timer);
		stopResync();
		powerMonitor.off("resume", restart);
		watched.delete(id);
	});
}

export function register(): void {
	handleWithEvent("window:ready", event => {
		watched.get(event.sender.id)?.health.pageReady(Date.now());
	});
	handleWithEvent("window:heartbeat", (event, seq) => {
		const entry = watched.get(event.sender.id);
		// Only the latest heartbeat counts; a late answer to an older one is ignored.
		if (entry && seq === entry.seq) entry.health.heartbeatAnswered(Date.now());
	});
	handleWithEvent("window:reload", event => {
		const entry = watched.get(event.sender.id);
		return entry ? confirmReload(entry, false) : false;
	});
	handleWithEvent("window:healthActed", event => {
		const entry = watched.get(event.sender.id);
		if (entry?.health.acted(Date.now())) publish(entry);
	});
}
