// @vitest-environment happy-dom
import { act, createElement as e, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AppInstallInfo, AppUpdateStatus, OmpUpdateStatus } from "@shared/contracts/updates";
import { i18n } from "../../../i18n";

const fake = vi.hoisted(() => ({
	openSheet: vi.fn(),
	updates: {
		app: null as AppUpdateStatus | null,
		install: null as AppInstallInfo | null,
		operation: null,
		omp: null as OmpUpdateStatus | null,
		brew: null,
		download: null,
		checkingApp: false,
		checkingOmp: false,
		restartingChats: 0,
		staleChats: [],
	},
}));
vi.mock("@/features/onboarding/updates", () => ({
	useUpdates: () => fake.updates,
	loadUpdates: vi.fn(),
	checkForUpdates: vi.fn(),
	openReleaseNotes: vi.fn(),
	openOmpNotes: vi.fn(),
	startAppReinstall: vi.fn(),
	quitForUpdate: vi.fn(),
	restartStaleChats: vi.fn(),
	APP_UPDATE_SHEET: "appUpdate",
	OMP_UPDATE_SHEET: "ompUpdate",
}));
vi.mock("@/state/app", () => ({
	useApp: Object.assign(
		(select: (state: { omp: { version: string; path: string } }) => unknown) =>
			select({ omp: { version: "19.2.1", path: "/mock/omp" } }),
		{ getState: () => ({ openSheet: fake.openSheet }) },
	),
}));
vi.mock("../shared", () => ({
	ipcErrorMessage: String,
	useResource: () => ({ data: null, error: null, loading: false, reload: vi.fn() }),
}));
vi.mock("../../onboarding/PackageManagerSwitch", () => ({ PackageManagerSwitch: () => null }));
vi.mock("../../../ui/Tooltip", () => ({
	Tooltip: ({ children }: { children: ReactNode }) => children,
	TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
import { AboutSection } from "./AboutSection";

let root: Root;
let element: HTMLDivElement;
beforeAll(async () => {
	await i18n.loadNamespaces(["settings", "onboarding"]);
});
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.assign(window, { vomp: { invoke: vi.fn(), platform: "darwin" } });
	fake.openSheet.mockReset();
	fake.updates.install = { method: "dmg", appPath: null, command: null, scoopGlobal: false };
	fake.updates.app = {
		currentVersion: "0.8.8",
		latestVersion: "0.8.8",
		updateAvailable: false,
		tag: "v0.8.8",
		releaseName: null,
		notes: null,
		releaseUrl: null,
		publishedAt: 1,
		assets: [],
		platformAsset: null,
		summary: null,
		checkedAt: 1,
		fromCache: true,
		error: null,
		releases: [],
	};
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	element.remove();
});

it("explains when a newer omp release requires updating visual-omp instead of showing Update omp", async () => {
	fake.updates.omp = {
		currentVersion: "19.2.1",
		latestVersion: "99.0.0",
		updateAvailable: false,
		requiresAppUpdate: true,
		maxSupportedVersion: "19.2.1",
		channel: "stable",
		packageMovedTo: null,
		checkedAt: 1,
		fromCache: false,
		error: null,
	};
	await act(async () => root.render(e(AboutSection)));
	expect(element.textContent).toContain("Up to date for this version of visual-omp. omp v99.0.0 needs a newer version of visual-omp.");
	const updateButton = [...element.querySelectorAll("button")].find(button => button.textContent === "Update omp");
	expect(updateButton).toBeUndefined();
});

it("shows Update omp and opens the omp update sheet when a supported omp update is available", async () => {
	fake.updates.omp = {
		currentVersion: "19.1.1",
		latestVersion: "19.2.1",
		updateAvailable: true,
		requiresAppUpdate: false,
		maxSupportedVersion: "19.2.1",
		channel: "stable",
		packageMovedTo: null,
		checkedAt: 1,
		fromCache: false,
		error: null,
	};
	await act(async () => root.render(e(AboutSection)));
	expect(element.textContent).toContain("v19.2.1 is available");
	const updateButton = [...element.querySelectorAll("button")].find(button => button.textContent === "Update omp")!;
	expect(updateButton).toBeDefined();
	await act(async () => updateButton.click());
	expect(fake.openSheet).toHaveBeenCalledWith("ompUpdate");
});
