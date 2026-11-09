import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDownload, AppInstallInfo, AppUpdateOutcome, AppUpdateStatus } from "@shared/contracts/updates";

const fake = vi.hoisted(() => ({
	listeners: new Map<string, (value: unknown) => void>(),
	invoke: vi.fn(), toast: vi.fn(), openSheet: vi.fn(),
}));
vi.mock("../../ui", () => ({ toast: fake.toast, updateToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock("../../state/app", () => ({
	allControllers: () => [], controllerFor: () => undefined,
	useApp: { getState: () => ({ openSheet: fake.openSheet }) },
}));
vi.mock("./quit", () => ({ quitAfterConfirm: async (action: () => Promise<void>) => { await action(); return true; } }));
vi.mock("../../registry/commands", () => ({ registerCommand: vi.fn() }));
vi.mock("../../registry/slots", () => ({ sheets: { register: vi.fn() } }));
import { APP_UPDATE_SHEET, RELEASE_NOTES_SHEET, installUpdateWatchers, openInstaller, openReleaseNotes, startAppRollback, useUpdates } from "./updates";

const install: AppInstallInfo = { method: "dmg", appPath: null, command: null, scoopGlobal: false };
const app: AppUpdateStatus = {
	currentVersion: "0.7.12", latestVersion: "0.7.12", updateAvailable: false,
	tag: "v0.7.12", releaseName: null, notes: null, releaseUrl: null,
	publishedAt: 1, assets: [], platformAsset: null, summary: null,
	checkedAt: 1, fromCache: true, error: null,
	releases: [{ version: "0.7.11", body: "Notes", url: null, publishedAt: 1,
		platformAsset: { name: "visual-omp.dmg", url: "https://github.com/decoy-dev/visual-omp/releases/download/v0.7.11/visual-omp.dmg", size: 12, digest: `sha256:${"a".repeat(64)}` } }],
};
const download: AppDownload = { version: "0.7.11", fileName: "visual-omp.dmg", filePath: "/Downloads/visual-omp.dmg", received: 0, total: 12, state: "downloading", error: null };
const outcome: AppUpdateOutcome = { method: "dmg", from: "0.7.11", to: "0.7.12", running: "0.7.12", updated: true };
const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };

beforeEach(() => {
	fake.listeners.clear(); fake.invoke.mockReset(); fake.toast.mockReset(); fake.openSheet.mockReset();
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "updates:app:check") return app;
		if (channel === "updates:app:install") return install;
		if (channel === "updates:app:download") return download;
		return null;
	});
	vi.stubGlobal("window", { vomp: {
		invoke: fake.invoke,
		on: (channel: string, callback: (value: unknown) => void) => { fake.listeners.set(channel, callback); return () => {}; },
	} });
	useUpdates.setState({ app, install, operation: null, download: null, downloadTarget: null, downloadOperation: "update", installerOpened: false });
});

function watchOutcome(value: AppUpdateOutcome) {
	fake.invoke.mockImplementation(async (channel: string) => channel === "updates:app:outcome" ? value : channel === "updates:app:check" ? app : channel === "updates:app:install" ? install : null);
	installUpdateWatchers();
}

describe("rollback entry points", () => {
	it("opens past notes with the requested release preselected", () => {
		openReleaseNotes("past", "0.7.11");
		expect(fake.openSheet).toHaveBeenCalledWith(RELEASE_NOTES_SHEET, { view: "past", initialVersion: "0.7.11" });
		openReleaseNotes();
		expect(fake.openSheet).toHaveBeenLastCalledWith(RELEASE_NOTES_SHEET, { view: "pending" });
	});
	it("offers the previous published installer after a successful forward update", async () => {
		useUpdates.setState({ app: null, install: null });
		watchOutcome(outcome); await flush();
		const notice = fake.toast.mock.calls[0]![0];
		expect(notice.secondaryAction.label).toBe("Roll back to v0.7.11");
		notice.secondaryAction.onClick();
		expect(fake.openSheet).toHaveBeenCalledWith(RELEASE_NOTES_SHEET, { view: "past", initialVersion: "0.7.11" });
	});
	it.each([
		{ ...outcome, from: "0.7.10" },
		{ ...outcome, from: "0.8.0" },
		{ ...outcome, from: "0.7.12" },
		{ ...outcome, updated: false },
	])("omits rollback for an unavailable, non-forward or failed outcome %#", async value => {
		watchOutcome(value); await flush();
		expect(fake.toast.mock.calls[0]![0].secondaryAction).toBeUndefined();
	});
	it("omits the notice action when managed metadata lacks a checksum", async () => {
		useUpdates.setState({ install: { ...install, method: "brew" }, app: { ...app, releases: app.releases!.map(release => ({ ...release, platformAsset: { ...release.platformAsset!, digest: null } })) } });
		watchOutcome(outcome); await flush();
		expect(fake.toast.mock.calls[0]![0].secondaryAction).toBeUndefined();
	});
});

describe("managed rollback download events", () => {
	it.each(["brew", "scoop"] as const)("downloads for %s without changing sheets or opening the installer", async method => {
		useUpdates.setState({ install: { ...install, method } });
		fake.invoke.mockImplementation(async (channel: string) => channel === "updates:app:download" ? { ...download, downloadOnly: true } : null);
		installUpdateWatchers();
		await startAppRollback("0.7.11", true);
		expect(fake.invoke).toHaveBeenCalledWith("updates:app:download", "0.7.11", true);
		expect(fake.openSheet).not.toHaveBeenCalled();
		fake.listeners.get("updates:app:download")!({ ...download, received: 12, state: "done", downloadOnly: true });
		await openInstaller(); await flush();
		expect(useUpdates.getState().download).toMatchObject({ state: "done", downloadOnly: true });
		expect(useUpdates.getState().operation).toBeNull();
		expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:runInstaller");
	});
	it("keeps normal rollback download and automatic installer opening unchanged", async () => {
		installUpdateWatchers();
		await startAppRollback("0.7.11");
		expect(fake.invoke).toHaveBeenCalledWith("updates:app:download", "0.7.11");
		expect(fake.openSheet).toHaveBeenCalledWith(APP_UPDATE_SHEET);
		fake.listeners.get("updates:app:download")!({ ...download, state: "done", received: 12 });
		fake.listeners.get("updates:app:download")!({ ...download, state: "done", received: 12 });
		await flush();
		expect(fake.invoke.mock.calls.filter(([channel]) => channel === "updates:app:runInstaller")).toHaveLength(1);
	});
	it("refuses managed automatic install and revalidates the selected release", async () => {
		useUpdates.setState({ install: { ...install, method: "brew" } });
		await expect(startAppRollback("0.7.11")).rejects.toThrow();
		await expect(startAppRollback("0.7.10", true)).rejects.toThrow();
		expect(fake.invoke).not.toHaveBeenCalledWith("updates:app:download", expect.anything(), expect.anything());
	});
	it("restores the previous renderer download when preparation fails", async () => {
		useUpdates.setState({ download: { ...download, state: "cancelled" }, downloadTarget: "0.7.10", downloadOperation: "rollback" });
		fake.invoke.mockRejectedValueOnce(new Error("Offline"));
		await expect(startAppRollback("0.7.11")).rejects.toThrow("Offline");
		expect(useUpdates.getState()).toMatchObject({ operation: null, downloadTarget: "0.7.10", download: { state: "cancelled" } });
		expect(fake.openSheet).not.toHaveBeenCalled();
	});
});
