import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	events: new Map<string, (event: { preventDefault(): void }) => void>(),
	windowEvents: new Map<string, (event: { preventDefault(): void }) => void>(),
	approve: null as ((allow: boolean) => void) | null,
	quit: vi.fn(), stopHosts: vi.fn(), stopOffice: vi.fn(), flush: vi.fn(), broadcast: vi.fn(), loaded: vi.fn(),
}));
vi.mock("./profile", () => ({}));
vi.mock("./services/diagnostics/runtime", () => ({ attachWindowDiagnostics: vi.fn(), crashReportingReady: Promise.resolve(), startDiagnostics: vi.fn() }));
vi.mock("electron", () => ({
	app: {
		isPackaged: true, requestSingleInstanceLock: () => true, quit: fake.quit, whenReady: () => Promise.resolve(),
		on: (name: string, listener: (event: { preventDefault(): void }) => void) => fake.events.set(name, listener),
	},
	BrowserWindow: vi.fn(function () {
		return {
			webContents: {
				session: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() },
				setWindowOpenHandler: vi.fn(), on: vi.fn(),
			},
			on: (name: string, listener: (event: { preventDefault(): void }) => void) => fake.windowEvents.set(name, listener),
			once: vi.fn(), loadFile: fake.loaded,
		};
	}),
	Menu: {}, nativeTheme: { shouldUseDarkColors: false }, shell: {},
}));
vi.mock("./attention", () => ({ attachAttentionWindow: vi.fn(), setAppUserModelId: vi.fn() }));
vi.mock("./contextMenu", () => ({ buildTextContextMenu: vi.fn() }));
vi.mock("./handlers", () => ({ registerHandlers: (approve: (allow: boolean) => void) => { fake.approve = approve; } }));
vi.mock("./features/config", () => ({ ensureNewUserApproval: vi.fn() }));
vi.mock("./ipc", () => ({ broadcast: fake.broadcast }));
vi.mock("./menu", () => ({ buildMenu: vi.fn() }));
vi.mock("./omp/host", () => ({ listHosts: () => [], stopAllHosts: fake.stopHosts }));
vi.mock("./omp/follow", () => ({ followSessions: vi.fn() }));
vi.mock("./omp/sessions", () => ({ stopWatchingSessions: vi.fn(), watchSessions: vi.fn() }));
vi.mock("./prefs", () => ({ getPrefs: () => ({}) }));
vi.mock("./terminals", () => ({ killAllTerminals: vi.fn() }));
vi.mock("./services/app-origin", () => ({ allowsAppPermission: vi.fn(), isAppUrl: vi.fn(), setAppRendererUrl: vi.fn() }));
vi.mock("./services/preview-protocol", () => ({ previewDocumentUrl: vi.fn(), previewNavigationRule: vi.fn(), registerPreviewScheme: vi.fn(), revokeAllPreviews: vi.fn() }));
vi.mock("./services/diagnostics/events", () => ({ flushDiagnostics: fake.flush }));
vi.mock("./services/preview-isolation-test", () => ({ startPreviewIsolationInspector: vi.fn() }));
vi.mock("./services/preview-office", () => ({ stopPreviewOffice: fake.stopOffice }));

beforeEach(async () => {
	vi.clearAllMocks(); vi.resetModules(); fake.events.clear(); fake.windowEvents.clear();
	fake.stopHosts.mockReset().mockResolvedValue(undefined);
	fake.stopOffice.mockReset().mockResolvedValue(undefined);
	fake.flush.mockReset().mockResolvedValue(undefined);
	// Reload startup registration to exercise Electron's actual quit handlers without opening a window.
	await import("./index");
	await vi.waitFor(() => expect(fake.loaded).toHaveBeenCalledOnce());
});

it("leaves Office previews running when the user cancels Quit", async () => {
	const event = { preventDefault: vi.fn() };
	fake.events.get("before-quit")!(event);
	expect(event.preventDefault).toHaveBeenCalledOnce();
	expect(fake.broadcast).toHaveBeenCalledWith("app:quitRequested", { reason: "quit" });
	fake.approve!(false);
	await Promise.resolve();
	expect(fake.stopOffice).not.toHaveBeenCalled();
	expect(fake.stopHosts).not.toHaveBeenCalled();
	expect(fake.quit).not.toHaveBeenCalled();
});

it("waits for Office cleanup and diagnostics before the final approved quit", async () => {
	const office = Promise.withResolvers<void>(), diagnostics = Promise.withResolvers<void>();
	fake.stopOffice.mockReturnValueOnce(office.promise);
	fake.flush.mockReturnValueOnce(diagnostics.promise);
	fake.approve!(true);
	await vi.waitFor(() => expect(fake.stopOffice).toHaveBeenCalledOnce());
	expect(fake.quit).not.toHaveBeenCalled();
	expect(fake.flush).not.toHaveBeenCalled();
	const repeatedQuit = { preventDefault: vi.fn() };
	fake.events.get("before-quit")!(repeatedQuit);
	expect(repeatedQuit.preventDefault).toHaveBeenCalledOnce();
	office.resolve();
	await vi.waitFor(() => expect(fake.flush).toHaveBeenCalledOnce());
	expect(fake.quit).not.toHaveBeenCalled();
	diagnostics.resolve();
	await vi.waitFor(() => expect(fake.quit).toHaveBeenCalledOnce());
	const finalQuit = { preventDefault: vi.fn() };
	fake.events.get("before-quit")!(finalQuit);
	expect(finalQuit.preventDefault).not.toHaveBeenCalled();
	expect(fake.stopOffice).toHaveBeenCalledOnce();
});

it("runs the same awaited shutdown when Quit has no window or hosts to warn about", async () => {
	fake.windowEvents.get("closed")!({ preventDefault: vi.fn() });
	const office = Promise.withResolvers<void>();
	fake.stopOffice.mockReturnValueOnce(office.promise);
	const event = { preventDefault: vi.fn() };
	fake.events.get("before-quit")!(event);
	expect(event.preventDefault).toHaveBeenCalledOnce();
	await vi.waitFor(() => expect(fake.stopOffice).toHaveBeenCalledOnce());
	expect(fake.quit).not.toHaveBeenCalled();
	office.resolve();
	await vi.waitFor(() => expect(fake.quit).toHaveBeenCalledOnce());
});
