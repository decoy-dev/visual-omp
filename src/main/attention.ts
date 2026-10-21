/**
 * Attention signals for chats that finished or need an answer while the window is in the background
 * (DESIGN §4.22). The renderer keeps the unseen count and sends it here with `app:attention`; main
 * validates every request and clears the native signals itself when the window gains focus,
 * reloads, loses its renderer or closes.
 *
 * - macOS: a Dock badge with the count and one informational bounce per newly unseen chat. The app
 *   also requests native banners; the tested ad-hoc signed build was denied them (the notification
 *   emits `failed`), so the handlers expect that.
 * - Windows: native toast requests (shown subject to the system notification settings), a flashing
 *   taskbar button and a count overlay on the taskbar button.
 */
import { join } from "node:path";
import { app, type BrowserWindow, nativeImage, Notification, shell } from "electron";
import { type AttentionState, NOTIFY_LIMITS } from "@shared/ipc";
import { broadcast, handle } from "./ipc";
import { getPrefs } from "./prefs";

/** electron-builder's `appId`; its NSIS installer gives the Start Menu shortcut this AppUserModelID. */
const APP_USER_MODEL_ID = "ltd.decoy.visualomp";
/** Notifications kept alive for their click handlers; the oldest is closed beyond this many. */
const MAX_LIVE_NOTIFICATIONS = 20;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The renderer sends a 32px PNG of a few KB; anything far larger is not an overlay badge. */
const MAX_OVERLAY_URL_LENGTH = 64 * 1024;
const MAX_OVERLAY_SIDE = 256;
const MAX_OVERLAY_DESCRIPTION_LENGTH = 256;

let window: BrowserWindow | null = null;
/**
 * Shown notifications, oldest first. A garbage-collected Notification loses its click handler, so
 * each one stays referenced until it is clicked, closed, refused or pushed out by newer ones.
 */
const live = new Set<Notification>();

/**
 * Windows attributes toasts to an AppUserModelID that a Start Menu shortcut carries. Packaged
 * builds use the installer's shortcut, or Scoop's ({@link tagScoopShortcut}); development builds
 * follow Electron's advice to use the executable path (toasts then need a Start Menu shortcut to
 * electron.exe).
 */
export function setAppUserModelId(): void {
	if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : process.execPath);
}

/**
 * Scoop's Start Menu shortcut (`Scoop Apps\visual-omp.lnk`) carries no AppUserModelID, so Windows
 * would show no toasts for a Scoop install. This writes the ID into that shortcut. A global Scoop
 * install keeps its shortcut in the all-users Start Menu, which needs administrator rights to
 * change, so its toasts stay unavailable.
 */
export function tagScoopShortcut(): void {
	const link = join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Scoop Apps", "visual-omp.lnk");
	try {
		const details = shell.readShortcutLink(link);
		if (details.appUserModelId !== APP_USER_MODEL_ID) shell.writeShortcutLink(link, "update", { ...details, appUserModelId: APP_USER_MODEL_ID });
	} catch {
		// No shortcut there (a global install, or the person removed it).
	}
}

/** Remove the Dock badge, the taskbar overlay and the taskbar flashing. */
function clearNative(): void {
	if (process.platform === "darwin") {
		app.dock?.setBadge("");
		return;
	}
	if (!window || window.isDestroyed()) return;
	window.flashFrame(false);
	if (process.platform === "win32") window.setOverlayIcon(null, "");
}

/**
 * The window that notification clicks bring forward and that carries the taskbar flashing and
 * overlay. Its native events clear the signals so a stuck or reloaded renderer cannot leave them.
 */
export function attachAttentionWindow(win: BrowserWindow): void {
	window = win;
	win.on("focus", clearNative);
	win.webContents.on("did-start-navigation", details => {
		if (details.isMainFrame && !details.isSameDocument) clearNative();
	});
	win.webContents.on("render-process-gone", clearNative);
	win.on("closed", () => {
		clearNative();
		if (window === win) window = null;
	});
}

function showWindow(): void {
	if (!window || window.isDestroyed()) return;
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

function notify(title: unknown, body: unknown, chatId: unknown): void {
	if (
		!isText(title, NOTIFY_LIMITS.title) ||
		!isText(body, NOTIFY_LIMITS.body) ||
		(chatId !== undefined && (!isText(chatId, NOTIFY_LIMITS.chatId) || chatId.length === 0))
	) {
		throw new TypeError("invalid notification request");
	}
	if (!getPrefs().notifications || !Notification.isSupported()) return;
	const notification = new Notification({ title, body });
	const release = () => live.delete(notification);
	notification.on("click", () => {
		release();
		showWindow();
		if (chatId !== undefined) broadcast("app:openChat", { chatId });
	});
	notification.on("close", release);
	// The tested ad-hoc signed macOS build was refused ("Notifications are not allowed for this application").
	notification.on("failed", release);
	live.add(notification);
	if (live.size > MAX_LIVE_NOTIFICATIONS) {
		const oldest = live.values().next().value;
		if (oldest) {
			live.delete(oldest);
			oldest.close();
		}
	}
	notification.show();
}

/** The request when it is well formed; throws otherwise (`handle` only casts IPC arguments). */
function parseAttention(value: unknown): AttentionState {
	const fail = (): never => {
		throw new TypeError("invalid attention state");
	};
	if (typeof value !== "object" || value === null) return fail();
	const { count, alert, overlay } = value as Record<string, unknown>;
	if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || typeof alert !== "boolean") return fail();
	if (overlay === null) return { count, alert, overlay };
	if (typeof overlay !== "object") return fail();
	const { image, description } = overlay as Record<string, unknown>;
	if (
		typeof image !== "string" ||
		image.length > MAX_OVERLAY_URL_LENGTH ||
		!image.startsWith(PNG_DATA_URL_PREFIX) ||
		!BASE64.test(image.slice(PNG_DATA_URL_PREFIX.length)) ||
		!isText(description, MAX_OVERLAY_DESCRIPTION_LENGTH)
	) {
		return fail();
	}
	return { count, alert, overlay: { image, description } };
}

/** The overlay as a native image; throws when the PNG does not decode or is not badge sized. */
function overlayImage(dataUrl: string): Electron.NativeImage {
	const image = nativeImage.createFromDataURL(dataUrl);
	const { width, height } = image.getSize();
	if (image.isEmpty() || width > MAX_OVERLAY_SIDE || height > MAX_OVERLAY_SIDE) throw new TypeError("invalid overlay image");
	return image;
}

function applyAttention(request: unknown): void {
	const { count, alert, overlay } = parseAttention(request);
	if (count === 0) {
		clearNative();
		return;
	}
	// A positive count only matters while the window is open and in the background.
	if (!getPrefs().notifications || !window || window.isDestroyed() || window.isFocused()) return;
	if (process.platform === "darwin") {
		app.dock?.setBadge(String(count));
		if (alert) app.dock?.bounce("informational");
		return;
	}
	// Decode first so a bad overlay rejects the request before anything changes.
	const image = process.platform === "win32" && overlay ? overlayImage(overlay.image) : null;
	if (alert) window.flashFrame(true);
	if (process.platform === "win32") window.setOverlayIcon(image, image && overlay ? overlay.description : "");
}

export function registerAttention(): void {
	handle("app:notify", notify);
	handle("app:attention", applyAttention);
}
