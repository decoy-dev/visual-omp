import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type * as Attention from "./attention";

const mocks = vi.hoisted(() => ({
	prefs: { notifications: true },
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	broadcast: vi.fn(),
	dock: { setBadge: vi.fn(), bounce: vi.fn() },
	image: { empty: false, width: 32, height: 32 },
	notifications: [] as Array<{ title: string; emit(event: string): void; close: Mock }>,
}));

vi.mock("electron", async () => {
	// vi.mock factories run before the file's own imports are initialized, so the factory loads what it needs.
	const { EventEmitter } = await import("node:events");
	class Notification extends EventEmitter {
		static isSupported = () => true;
		title: string;
		show = vi.fn();
		close = vi.fn();
		constructor(options: { title: string }) {
			super();
			this.title = options.title;
			mocks.notifications.push(this);
		}
	}
	return {
		app: { dock: mocks.dock, isPackaged: true, setAppUserModelId: vi.fn() },
		nativeImage: {
			createFromDataURL: () => ({
				isEmpty: () => mocks.image.empty,
				getSize: () => ({ width: mocks.image.width, height: mocks.image.height }),
			}),
		},
		Notification,
	};
});
vi.mock("./ipc", () => ({
	handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
	broadcast: mocks.broadcast,
}));
vi.mock("./prefs", () => ({ getPrefs: () => mocks.prefs }));

class FakeWindow extends EventEmitter {
	webContents = new EventEmitter();
	focused = false;
	minimized = false;
	flashFrame = vi.fn();
	setOverlayIcon = vi.fn();
	restore = vi.fn();
	show = vi.fn();
	focus = vi.fn();
	isFocused = () => this.focused;
	isMinimized = () => this.minimized;
	isDestroyed = () => false;
}

const realPlatform = process.platform;
const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: platform });

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const overlay = { image: PNG, description: "2 chats finished or need your answer" };

let attention: typeof Attention;
let win: FakeWindow;

async function load(platform: NodeJS.Platform) {
	setPlatform(platform);
	vi.resetModules();
	mocks.handlers.clear();
	// A fresh copy per test: the module keeps its window and notifications in module state.
	attention = await import("./attention");
	attention.registerAttention();
	win = new FakeWindow();
	attention.attachAttentionWindow(win as unknown as BrowserWindow);
}

const attend = (state: unknown) => mocks.handlers.get("app:attention")!(state);
const notify = (...args: unknown[]) => mocks.handlers.get("app:notify")!(...args);

beforeEach(() => {
	mocks.prefs.notifications = true;
	mocks.image = { empty: false, width: 32, height: 32 };
	mocks.notifications.length = 0;
	vi.clearAllMocks();
});

afterEach(() => setPlatform(realPlatform));

describe("app:attention validation", () => {
	beforeEach(() => load("win32"));

	it.each([
		["a missing request", undefined],
		["a negative count", { count: -1, alert: false, overlay: null }],
		["a fractional count", { count: 1.5, alert: false, overlay: null }],
		["an unsafe count", { count: Number.MAX_SAFE_INTEGER + 1, alert: false, overlay: null }],
		["a string count", { count: "1", alert: false, overlay: null }],
		["a missing alert", { count: 1, overlay: null }],
		["a missing overlay", { count: 1, alert: true }],
		["a non-PNG overlay", { count: 1, alert: true, overlay: { ...overlay, image: "data:image/svg+xml;base64,PHN2Zz4=" } }],
		["broken base64", { count: 1, alert: true, overlay: { ...overlay, image: `${PNG}!` } }],
		["an oversized overlay", { count: 1, alert: true, overlay: { ...overlay, image: PNG + "A".repeat(70_000) } }],
		["a missing description", { count: 1, alert: true, overlay: { image: PNG } }],
		["a long description", { count: 1, alert: true, overlay: { ...overlay, description: "x".repeat(300) } }],
	])("rejects %s", (_name, state) => {
		expect(() => attend(state)).toThrow(TypeError);
		expect(win.flashFrame).not.toHaveBeenCalled();
		expect(win.setOverlayIcon).not.toHaveBeenCalled();
	});

	it("rejects overlays that decode empty or larger than a badge, before flashing", () => {
		mocks.image.empty = true;
		expect(() => attend({ count: 1, alert: true, overlay })).toThrow(TypeError);
		mocks.image = { empty: false, width: 512, height: 512 };
		expect(() => attend({ count: 1, alert: true, overlay })).toThrow(TypeError);
		expect(win.flashFrame).not.toHaveBeenCalled();
		expect(win.setOverlayIcon).not.toHaveBeenCalled();
	});

	it("flashes and sets the overlay for a valid positive request", () => {
		attend({ count: 2, alert: true, overlay });
		expect(win.flashFrame).toHaveBeenCalledWith(true);
		expect(win.setOverlayIcon).toHaveBeenCalledWith(expect.anything(), overlay.description);
	});

	it("clears on a zero count and never flashes for it", () => {
		attend({ count: 0, alert: true, overlay: null });
		expect(win.flashFrame).toHaveBeenCalledWith(false);
		expect(win.flashFrame).not.toHaveBeenCalledWith(true);
		expect(win.setOverlayIcon).toHaveBeenCalledWith(null, "");
	});

	it("ignores positive requests while the switch is off", () => {
		mocks.prefs.notifications = false;
		attend({ count: 1, alert: true, overlay });
		expect(win.flashFrame).not.toHaveBeenCalled();
		expect(win.setOverlayIcon).not.toHaveBeenCalled();
	});
});

describe("app:notify validation", () => {
	beforeEach(() => load("win32"));

	it.each([
		["a missing title", [undefined, "body"]],
		["a long title", ["x".repeat(257), "body"]],
		["a long body", ["title", "x".repeat(1025)]],
		["an empty chat id", ["title", "body", ""]],
		["a long chat id", ["title", "body", "x".repeat(129)]],
		["a numeric chat id", ["title", "body", 7]],
	])("rejects %s", (_name, args) => {
		expect(() => notify(...args)).toThrow(TypeError);
		expect(mocks.notifications).toHaveLength(0);
	});

	it("shows a valid notification, and a click focuses the window and opens the chat", () => {
		win.minimized = true;
		notify("Fix checkout", "Finished", "t1");
		expect(mocks.notifications).toHaveLength(1);
		mocks.notifications[0]!.emit("click");
		expect(win.restore).toHaveBeenCalled();
		expect(win.focus).toHaveBeenCalled();
		expect(mocks.broadcast).toHaveBeenCalledWith("app:openChat", { chatId: "t1" });
	});

	it("shows nothing while the switch is off", () => {
		mocks.prefs.notifications = false;
		notify("Fix checkout", "Finished", "t1");
		expect(mocks.notifications).toHaveLength(0);
	});
});

describe("retained notifications", () => {
	beforeEach(() => load("win32"));

	const closed = () => mocks.notifications.filter(entry => entry.close.mock.calls.length > 0).map(entry => entry.title);

	it("closes the oldest notification beyond 20", () => {
		for (let index = 1; index <= 21; index++) notify(`n${index}`, "body");
		expect(closed()).toEqual(["n1"]);
		notify("n22", "body");
		expect(closed()).toEqual(["n1", "n2"]);
	});

	it("releases notifications on click, close and failure", () => {
		for (let index = 1; index <= 20; index++) notify(`n${index}`, "body");
		mocks.notifications[0]!.emit("click");
		mocks.notifications[1]!.emit("close");
		mocks.notifications[2]!.emit("failed");
		for (let index = 21; index <= 23; index++) notify(`n${index}`, "body");
		expect(closed()).toEqual([]);
		notify("n24", "body");
		expect(closed()).toEqual(["n4"]);
	});
});

describe("window lifecycle", () => {
	it.each([
		["focus", (target: FakeWindow) => target.emit("focus")],
		["a reload", (target: FakeWindow) => target.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })],
		["renderer loss", (target: FakeWindow) => target.webContents.emit("render-process-gone", {}, { reason: "crashed" })],
		["closing", (target: FakeWindow) => target.emit("closed")],
	])("clears the taskbar on %s", async (_name, trigger) => {
		await load("win32");
		attend({ count: 1, alert: true, overlay });
		vi.clearAllMocks();
		trigger(win);
		expect(win.flashFrame).toHaveBeenCalledWith(false);
		expect(win.setOverlayIcon).toHaveBeenCalledWith(null, "");
	});

	it.each([
		["focus", (target: FakeWindow) => target.emit("focus")],
		["a reload", (target: FakeWindow) => target.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })],
		["renderer loss", (target: FakeWindow) => target.webContents.emit("render-process-gone", {}, { reason: "crashed" })],
		["closing", (target: FakeWindow) => target.emit("closed")],
	])("clears the Dock badge on %s", async (_name, trigger) => {
		await load("darwin");
		attend({ count: 1, alert: true, overlay: null });
		expect(mocks.dock.setBadge).toHaveBeenLastCalledWith("1");
		expect(mocks.dock.bounce).toHaveBeenCalledWith("informational");
		trigger(win);
		expect(mocks.dock.setBadge).toHaveBeenLastCalledWith("");
	});

	it("keeps in-page navigation from clearing", async () => {
		await load("win32");
		win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
		expect(win.flashFrame).not.toHaveBeenCalled();
	});

	it("ignores a positive update that arrives after the window gained focus", async () => {
		await load("darwin");
		win.focused = true;
		win.emit("focus");
		attend({ count: 1, alert: true, overlay: null });
		expect(mocks.dock.setBadge).toHaveBeenLastCalledWith("");
		expect(mocks.dock.bounce).not.toHaveBeenCalled();
	});

	it("ignores positive updates once the window is closed, but still clears", async () => {
		await load("darwin");
		win.emit("closed");
		attend({ count: 2, alert: true, overlay: null });
		expect(mocks.dock.setBadge).not.toHaveBeenCalledWith("2");
		expect(mocks.dock.bounce).not.toHaveBeenCalled();
		attend({ count: 0, alert: false, overlay: null });
		expect(mocks.dock.setBadge).toHaveBeenLastCalledWith("");
	});
});
