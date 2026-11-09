// @vitest-environment happy-dom
import { act, createElement as e, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AppInstallInfo, AppUpdateStatus } from "@shared/contracts/updates";
import { i18n } from "../../../i18n";

const fake = vi.hoisted(() => ({
	openReleaseNotes: vi.fn(),
	updates: { app: null as AppUpdateStatus | null, install: null as AppInstallInfo | null, operation: null, omp: null, brew: null, download: null, checkingApp: false, checkingOmp: false, restartingChats: 0, staleChats: [] },
}));
vi.mock("@/features/onboarding/updates", () => ({
	useUpdates: () => fake.updates, loadUpdates: vi.fn(), checkForUpdates: vi.fn(),
	openReleaseNotes: fake.openReleaseNotes, openOmpNotes: vi.fn(), startAppReinstall: vi.fn(),
	quitForUpdate: vi.fn(), restartStaleChats: vi.fn(), APP_UPDATE_SHEET: "appUpdate", OMP_UPDATE_SHEET: "ompUpdate",
}));
vi.mock("@/state/app", () => ({ useApp: (select: (state: { omp: null }) => unknown) => select({ omp: null }) }));
vi.mock("../shared", () => ({ ipcErrorMessage: String, useResource: () => ({ data: null, error: null, loading: false, reload: vi.fn() }) }));
vi.mock("../../onboarding/PackageManagerSwitch", () => ({ PackageManagerSwitch: () => null }));
vi.mock("../../../ui/Tooltip", () => ({
	Tooltip: ({ children }: { children: ReactNode }) => children,
	TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
import { AboutSection } from "./AboutSection";

let root: Root;
let element: HTMLDivElement;
beforeAll(async () => { await i18n.loadNamespaces(["settings", "onboarding"]); });
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.assign(window, { vomp: { invoke: vi.fn(), platform: "darwin" } });
	fake.openReleaseNotes.mockReset();
	fake.updates.install = { method: "dmg", appPath: null, command: null, scoopGlobal: false };
	fake.updates.app = {
		currentVersion: "0.7.12", latestVersion: "0.7.12", updateAvailable: false, tag: "v0.7.12", releaseName: null,
		notes: null, releaseUrl: null, publishedAt: 1, assets: [], platformAsset: null, summary: null, checkedAt: 1, fromCache: true, error: null,
		releases: ["0.7.9", "0.7.11", "0.7.10"].map(version => ({ version, body: "Notes", url: null, publishedAt: 1, platformAsset: { name: "visual-omp.dmg", url: "https://github.com/asset", size: 1 } })),
	};
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

it("opens the highest eligible previous release from About", async () => {
	await act(async () => root.render(e(AboutSection)));
	const action = [...element.querySelectorAll("button")].find(button => button.textContent === "Roll back…")!;
	expect(action.disabled).toBe(false);
	await act(async () => action.click());
	expect(fake.openReleaseNotes).toHaveBeenCalledWith("past", "0.7.11");
});
it.each(["manual", "missing", "digest"])("disables About rollback with a reason when %s", async reason => {
	if (reason === "manual") fake.updates.install!.method = "manual";
	if (reason === "missing") fake.updates.app!.releases = [];
	if (reason === "digest") fake.updates.install!.method = "brew";
	await act(async () => root.render(e(AboutSection)));
	const action = [...element.querySelectorAll("button")].find(button => button.textContent === "Roll back…")!;
	expect(action.disabled).toBe(true);
	expect(action.title.length).toBeGreaterThan(0);
});
