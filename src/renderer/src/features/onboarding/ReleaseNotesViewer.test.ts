// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import type * as ReactI18next from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AppDownload, AppInstallInfo, AppUpdateStatus } from "@shared/contracts/updates";
import messages from "../../i18n/en/onboarding.json";
import { ManagedRollbackSteps, ReleaseNotesViewer } from "./ReleaseNotesViewer";

// Replace portal presentation primitives so static guidance and interactive
// confirmations both exercise the real viewer selection and eligibility.
vi.mock("../../ui", async () => {
	// Vitest hoists this factory before static imports initialize.
	const { createElement } = await import("react");
	const shell = ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => createElement("div", null, children, footer);
	return {
		Dialog: shell, DialogContent: shell, PresenceSwap: shell,
		Tabs: shell, TabsContent: shell, TabsList: shell, TabsTrigger: shell,
		Select: ({ value, children }: { value: string; children?: ReactNode }) => createElement("div", { "data-selected-version": value }, children),
		SelectItem: shell,
		Button: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => createElement("button", { disabled, onClick }, children),
		Progress: ({ value }: { value?: number }) => createElement("progress", { value, max: 100 }),
		toast: vi.fn(),
	};
});
vi.mock("react-i18next", async importOriginal => {
	const actual = await importOriginal<typeof ReactI18next>();
	const { default: i18n } = await import("i18next");
	return { ...actual, useTranslation: () => ({ t: i18n.getFixedT("en", "onboarding"), i18n }) };
});

beforeAll(async () => {
	await i18next.init({ lng: "en", resources: { en: { onboarding: messages } }, interpolation: { escapeValue: false } });
});

const version = "0.7.10";
const asset = { name: "visual-omp-0.7.10-arm64.dmg", url: "https://github.com/decoy-dev/visual-omp/releases/download/v0.7.10/visual-omp-0.7.10-arm64.dmg", size: 100, digest: `sha256:${"a".repeat(64)}` };
const status: AppUpdateStatus = {
	currentVersion: "0.7.12", latestVersion: "0.7.12", updateAvailable: false,
	tag: "v0.7.12", releaseName: null, notes: null, releaseUrl: null, publishedAt: null,
	assets: [], platformAsset: null, summary: null, checkedAt: 1, fromCache: false, error: null,
	releases: [
		{ version: "0.7.11", body: "Newer historical fixture", url: null, publishedAt: null, platformAsset: asset },
		{ version, body: "Selected historical fixture", url: null, publishedAt: null, platformAsset: asset },
	],
};
const install: AppInstallInfo = { method: "brew", appPath: "/Applications/visual-omp.app", command: null, scoopGlobal: false };
const noop = () => {};
function viewer(app = status, method: AppInstallInfo["method"] = "brew") {
	return renderToStaticMarkup(createElement(ReleaseNotesViewer, {
		status: app, installedVersion: "0.7.12", installInfo: { ...install, method },
		initialView: "past", initialVersion: version, open: true,
		onExited: noop, close: noop, onUpdate: noop, onRollback: async () => {},
	}));
}
function steps(method: "brew" | "scoop", global = false, retained = false, download?: AppDownload) {
	return renderToStaticMarkup(createElement(ManagedRollbackSteps, { method, version, global, retained, download }));
}

describe("managed rollback guidance", () => {
	it("keeps Homebrew data and gives installer and return-to-manager instructions", () => {
		const html = steps("brew");
		expect(html).toContain("brew uninstall --cask visual-omp");
		expect(html).not.toContain("brew uninstall --cask visual-omp --zap");
		expect(html).toContain("Leave out --zap");
		expect(html).toContain("drag visual-omp to Applications");
		expect(html).toContain("delete /Applications/visual-omp.app");
		expect(html).toContain("brew install --cask decoy-dev/tap/visual-omp");
		expect(html).toContain("app data and omp settings are kept");
		expect(html).toContain("Package-manager updates will stop managing this copy");
	});

	it("uses local Scoop uninstall without purge or a reset for an absent retained version", () => {
		const html = steps("scoop");
		expect(html).toContain("scoop uninstall visual-omp</code>");
		expect(html).not.toContain("--global");
		expect(html).not.toContain("scoop reset");
		expect(html).toContain("Leave out -p");
		expect(html).toContain("Run the downloaded installer");
		expect(html).toContain("Windows Settings &gt; Apps");
		expect(html).toContain("scoop install visual-omp");
	});

	it("requires administrator PowerShell and --global for all-users Scoop copies", () => {
		const html = steps("scoop", true);
		expect(html).toContain("administrator PowerShell");
		expect(html).toContain("scoop uninstall visual-omp --global</code>");
		expect(html).not.toContain("scoop reset");
	});

	it.each([false, true])("offers reset only for a retained Scoop directory (global=%s)", global => {
		const html = steps("scoop", global, true);
		expect(html).toContain(`scoop reset visual-omp@${version}${global ? " --global" : ""}</code>`);
		expect(html).toContain(`Scoop still retains v${version}`);
	});

	it("renders verified download completion without claiming the installer ran", () => {
		const html = steps("brew", false, false, { version, fileName: asset.name, filePath: "/Users/fixture/Downloads/visual-omp.dmg", downloadOnly: true, state: "done", received: 100, total: 100, error: null });
		expect(html).toContain("Verified installer saved to /Users/fixture/Downloads/visual-omp.dmg");
		expect(html).toContain("it does not run automatically");
	});
});

describe("release notes rollback preselection", () => {
	it("renders the requested older release rather than the installed or nearest release", () => {
		const html = viewer();
		expect(html).toContain(`data-selected-version="${version}"`);
		expect(html).toContain("Selected historical fixture");
		expect(html).not.toContain("Newer historical fixture");
		expect(html).toContain(`Download v${version} installer`);
	});

	it.each(["brew", "scoop"] as const)("withholds the managed download when the selected %s asset has no SHA-256", method => {
		const html = viewer({ ...status, releases: status.releases!.map(release => ({ ...release, platformAsset: { ...asset, digest: null } })) }, method);
		expect(html).toContain("no published SHA-256 checksum");
		expect(html).not.toContain(`Download v${version} installer`);
		expect(html).not.toContain("Package-manager updates will stop managing this copy");
	});

	it("keeps direct installer rollback available without imposing managed-only digest guidance", () => {
		const html = viewer({ ...status, releases: status.releases!.map(release => ({ ...release, platformAsset: { ...asset, digest: null } })) }, "dmg");
		expect(html).toContain(`Install v${version}`);
		expect(html).not.toContain("no published SHA-256 checksum");
	});
});

describe("rollback confirmation copy", () => {
	it.each(["brew", "scoop", "dmg", "nsis"] as const)("describes the action accurately for %s copies", async method => {
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		try {
			await act(async () => root.render(createElement(ReleaseNotesViewer, {
				status, installedVersion: "0.7.12", installInfo: { ...install, method },
				initialView: "past", initialVersion: version, open: true,
				onExited: noop, close: noop, onUpdate: noop, onRollback: async () => {},
			})));
			const managed = method === "brew" || method === "scoop";
			const label = managed ? `Download v${version} installer` : `Install v${version}`;
			const action = [...element.querySelectorAll("button")].find(button => button.textContent === label)!;
			await act(async () => action.click());
			expect(element.textContent).toContain(managed ? messages.update.rollback.managedConfirmation : messages.update.rollback.preserved);
			expect(element.textContent).not.toContain(managed ? messages.update.rollback.preserved : messages.update.rollback.managedConfirmation);
		} finally {
			await act(async () => root.unmount());
			element.remove();
		}
	});
});
