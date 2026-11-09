/**
 * Update surfaces (DESIGN §4.22). Settings → About is the one place for updates: it shows both
 * versions, runs the checks and starts either update. A toast announces a new visual-omp release.
 * The app update runs in `AppUpdateSheet`: `brew upgrade --cask` in a terminal for Homebrew
 * installs, a restart through `scoop update` for Scoop installs, otherwise the installer downloads
 * to ~/Downloads and opens. The omp update streams in `OmpUpdateSheet`, after which open chats
 * can be restarted onto the new omp. This module holds the state, checks and actions and loads with
 * the app; the sheets load from `./UpdateSheets` on first open or in idle time.
 */
import { ArrowsClockwise } from "@phosphor-icons/react";
import { create } from "zustand";
import type { AppDownload, AppInstallInfo, AppInstallOperation, AppUpdateStatus, OmpUpdateRun, OmpUpdateStatus } from "@shared/contracts/updates";
import { compareSemver } from "@shared/semver";
import { eligibleRollbackReleases } from "@shared/rollback";
import type { NativeSnapshot } from "@shared/contracts/native";
import { i18n } from "../../i18n";
import { registerCommand } from "../../registry/commands";
import { DialogLoadFailed, lazyView } from "../../registry/lazy";
import { sheets } from "../../registry/slots";
import { allControllers, controllerFor, useApp } from "../../state/app";
import { openSettings } from "../../state/navigation";
import { workInFlight } from "../../state/chatWork";
import type { SessionController } from "../../state/session";
import { dismissToast, toast, updateToast } from "../../ui";
import { ipcErrorMessage as errorText } from "../manage/shared";
import { quitAfterConfirm } from "./quit";
import { CommandRun } from "./terminal";
import type { ReleaseNotesView } from "./ReleaseNotesViewer";

const updateSheets = () => import("./UpdateSheets");
/** The omp update sheet, also opened from the setup screen; there, outside the sheet host, its failure dialog stands in too. */
export const OmpUpdateSheet = lazyView(() => updateSheets().then(module => module.OmpUpdateSheet), null, DialogLoadFailed);

export const OMP_UPDATE_SHEET = "onboarding.ompUpdate";
export const APP_UPDATE_SHEET = "onboarding.appUpdate";
export const RELEASE_NOTES_SHEET = "onboarding.releaseNotes";
export const OMP_NOTES_SHEET = "onboarding.ompNotes";
const engineSnapshots = new Map<string, NativeSnapshot>();
const announcedEngines = new Set<string>();
const noticeChecks = new Set<string>();
let engineNotice: string | null = null;
let engineNoticeVersion: string | null = null;
let engineNoticeCount = 0;

export function openOmpNotes(): void {
	useApp.getState().openSheet(OMP_NOTES_SHEET);
}

export async function acknowledgeOmpNotes(version: string): Promise<void> {
	await window.vomp.invoke("updates:omp:acknowledge", version);
	if (engineNotice && engineNoticeVersion === version) {
		dismissToast(engineNotice);
		engineNotice = null;
	}
}

function engineNoticeActions(version: string, count: number) {
	const t = i18n.getFixedT(null, "onboarding");
	return {
		description: count ? t("update.omp.restartNote", { count }) : t("update.omp.doneVersion", { version }),
		action: count ? { label: t("update.omp.restartChats"), onClick: () => void restartStaleChats() }
			: { label: t("update.omp.whatsNew"), onClick: openOmpNotes },
		secondaryAction: count ? { label: t("update.omp.whatsNew"), onClick: openOmpNotes } : undefined,
	};
}

/** Main persists delivery independently of omp's hidden startup marker and this renderer's lifetime. */
function checkEngineNotice(version: string, stale: boolean): void {
	const key = `${version}:${stale}`;
	if (noticeChecks.has(key)) return;
	noticeChecks.add(key);
	void window.vomp.invoke("updates:omp:notice", stale ? version : undefined).then(notice => {
		if (!notice || notice.pendingVersion !== version || notice.acknowledgedVersion === version
			|| useUpdates.getState().installedOmp !== version || announcedEngines.has(version)) return;
		announcedEngines.add(version);
		const t = i18n.getFixedT(null, "onboarding");
		const count = useUpdates.getState().staleChats.length;
		if (engineNotice) dismissToast(engineNotice);
		engineNoticeVersion = version;
		engineNoticeCount = count;
		engineNotice = toast({
			tone: "info", sticky: true, message: t("update.omp.updated", { version }),
			...engineNoticeActions(version, count),
		});
	}).catch(() => noticeChecks.delete(key));
}
let appUpdateNotice: string | null = null;

export function openReleaseNotes(view: ReleaseNotesView = "pending", initialVersion?: string): void {
	if (appUpdateNotice) dismissToast(appUpdateNotice);
	appUpdateNotice = null;
	useApp.getState().openSheet(RELEASE_NOTES_SHEET, { view, ...(initialVersion ? { initialVersion } : {}) });
}

/** How long a restarted chat may take to reconnect before it counts as failed. */
const RESTART_CONFIRM_MS = 60_000;

/** The Homebrew upgrade (`brew` installs), from the terminal run to the version check that follows. */
export type BrewUpgrade =
	| { phase: "running"; run: CommandRun }
	| { phase: "failed"; run: CommandRun; code: number }
	| { phase: "verifying"; run: CommandRun }
	/** The `.app` on disk is now the newer `version`; restarting opens it. */
	| { phase: "ready"; run: CommandRun; version: string }
	/** brew exited 0 but the `.app` on disk is not newer than the running app (or its version couldn't be read). */
	| { phase: "unchanged"; run: CommandRun; version: string | null }
	/** brew exited 0 but reading the installed version failed. */
	| { phase: "verifyFailed"; run: CommandRun; message: string }
	| { phase: "error"; message: string };

interface UpdatesState {
	app: AppUpdateStatus | null;
	omp: OmpUpdateStatus | null;
	installedOmp: string | null;
	install: AppInstallInfo | null;
	operation: AppInstallOperation | null;
	checkingApp: boolean;
	checkingOmp: boolean;
	brew: BrewUpgrade | null;
	download: AppDownload | null;
	/** Explicit installer version, retained through cancellation and retry, including the running version. */
	downloadTarget: string | null;
	downloadOperation: "update" | "rollback" | "reinstall";
	/** The downloaded installer was opened: the disk image in Finder, or the NSIS installer (the app then quits). */
	installerOpened: boolean;
	/** Chat tabs whose running omp differs from the installed engine. */
	staleChats: readonly string[];
	/** Chats sent /restart that haven't reconnected yet. */
	restartingChats: number;
}

export const useUpdates = create<UpdatesState>(() => ({
	app: null,
	omp: null,
	installedOmp: null,
	install: null,
	operation: null,
	checkingApp: false,
	checkingOmp: false,
	brew: null,
	download: null,
	downloadTarget: null,
	downloadOperation: "update",
	installerOpened: false,
	staleChats: [],
	restartingChats: 0,
}));

/** Latest `omp update --check` result (status bar omp chip). Null until the first check finishes. */
export function useOmpUpdateStatus(): OmpUpdateStatus | null {
	return useUpdates(state => state.omp);
}

async function checkApp(force: boolean, includeSkipped = false): Promise<void> {
	useUpdates.setState({ checkingApp: true });
	try {
		useUpdates.setState({ app: await window.vomp.invoke("updates:app:check", force, includeSkipped) });
	} finally {
		useUpdates.setState({ checkingApp: false });
	}
}

async function checkOmp(force: boolean): Promise<void> {
	useUpdates.setState({ checkingOmp: true });
	try {
		useUpdates.setState({ omp: await window.vomp.invoke("updates:omp:check", force) });
		const installed = useUpdates.getState().installedOmp;
		if (installed) reconcileInstalledOmp(installed);
	} finally {
		useUpdates.setState({ checkingOmp: false });
	}
}

export async function loadInstall(): Promise<AppInstallInfo> {
	const install = await window.vomp.invoke("updates:app:install");
	useUpdates.setState({ install });
	return install;
}

/** Checks visual-omp and omp now, bypassing main's 30-minute cache. */
export async function checkForUpdates(): Promise<void> {
	await Promise.all([checkApp(true, true), checkOmp(true), loadInstall()]);
}

/** Loads the last results (main's 30-minute cache), checking only what is stale. */
export async function loadUpdates(): Promise<void> {
	await Promise.all([checkApp(false), checkOmp(false), loadInstall()]);
	useUpdates.setState({ operation: await window.vomp.invoke("updates:app:operation") ?? null });
}

/**
 * Starts the visual-omp update the way this copy was installed: Homebrew upgrade, installer
 * download, or (development builds, other platforms) the release page in the browser. A Scoop
 * install only opens the sheet, whose button restarts through Scoop.
 */
export async function startAppUpdate(): Promise<void> {
	const t = i18n.getFixedT(null, "onboarding");
	const { app } = useUpdates.getState();
	if (useUpdates.getState().operation) return;
	if (!app?.updateAvailable) return;
	const install = useUpdates.getState().install ?? (await loadInstall());
	const useInstaller = install.method === "dmg" || install.method === "nsis";
	try {
		await window.vomp.invoke("updates:app:resume");
		useUpdates.setState({ app: { ...app, skippedThroughVersion: null } });
	} catch (error) {
		toast({ tone: "err", message: t("update.app.download.startFailed"), description: errorText(error) });
		return;
	}
	if (install.method === "manual" || (useInstaller && !app.platformAsset)) {
		if (app.releaseUrl) void window.vomp.invoke("app:openExternal", app.releaseUrl);
		return;
	}
	if (install.method === "brew") void startBrewUpgrade();
	else if (useInstaller) {
		const previousHandledDownload = handledDownload;
		handledDownload = null;
		const previous = useUpdates.getState();
		useUpdates.setState({ downloadTarget: null, downloadOperation: "update", download: null, installerOpened: false });
		try {
			useUpdates.setState({ operation: "update" });
			const download = await window.vomp.invoke("updates:app:download");
			onDownload(download);
		} catch (error) {
			useUpdates.setState({ operation: null });
			handledDownload = previousHandledDownload;
			useUpdates.setState({
				download: previous.download,
				downloadTarget: previous.downloadTarget,
				downloadOperation: previous.downloadOperation,
				installerOpened: previous.installerOpened,
			});
			toast({ tone: "err", message: t("update.app.download.startFailed"), description: errorText(error) });
			return;
		}
	}
	useApp.getState().openSheet(APP_UPDATE_SHEET);
}

/** Starts a confirmed earlier installer using fresh official release metadata in main. */
export async function startAppRollback(version: string, downloadOnly = false): Promise<void> {
	const install = useUpdates.getState().install ?? (await loadInstall());
	const managed = install.method === "brew" || install.method === "scoop";
	if (install.method !== "dmg" && install.method !== "nsis" && !(managed && downloadOnly)) {
		throw new Error(i18n.t("onboarding:update.rollback.unavailable", { defaultValue: "No earlier published installer is available for this copy." }));
	}
	if (!eligibleRollbackReleases(useUpdates.getState().app, install, version).length) {
		throw new Error(i18n.t("onboarding:update.rollback.unavailable", { defaultValue: "No earlier published installer is available for this copy." }));
	}
	await startTargetedAppDownload(version, "rollback", downloadOnly);
}

/** Reuses the installer download without clearing the user's rollback skip. */
export async function startAppReinstall(version: string): Promise<void> {
	const install = useUpdates.getState().install ?? (await loadInstall());
	if (install.method !== "dmg" && install.method !== "nsis") throw new Error(i18n.t("onboarding:update.reinstall.installerOnly"));
	await startTargetedAppDownload(version, "reinstall");
}

async function startTargetedAppDownload(version: string, operation: "rollback" | "reinstall", downloadOnly = false): Promise<void> {
	if (useUpdates.getState().operation) throw new Error(i18n.t("onboarding:update.installSwitch.busy"));
	const previousHandledDownload = handledDownload;
	handledDownload = null;
	const previous = useUpdates.getState();
	useUpdates.setState({ downloadTarget: version, downloadOperation: operation, download: null, installerOpened: false });
	try {
		useUpdates.setState({ operation: operation === "reinstall" ? "reinstall" : "update" });
		const download = downloadOnly
			? await window.vomp.invoke("updates:app:download", version, true)
			: await window.vomp.invoke("updates:app:download", version);
		onDownload(download);
		if (!downloadOnly) useApp.getState().openSheet(APP_UPDATE_SHEET);
	} catch (error) {
		useUpdates.setState({ operation: null });
		handledDownload = previousHandledDownload;
		useUpdates.setState({
			download: previous.download,
			downloadTarget: previous.downloadTarget,
			downloadOperation: previous.downloadOperation,
			installerOpened: previous.installerOpened,
		});
		throw error;
	}
}

export async function retryAppDownload(): Promise<void> {
	const { downloadTarget: target, downloadOperation, download } = useUpdates.getState();
	if (!target) return startAppUpdate();
	try {
		if (downloadOperation === "reinstall") await startAppReinstall(target);
		else await startAppRollback(target, download?.downloadOnly);
	} catch (error) {
		toast({ tone: "err", message: i18n.t("onboarding:update.app.download.startFailed"), description: errorText(error) });
	}
}

/** Set while the brew run is being started, so a second click can't start another. */
let brewStarting = false;

export async function startBrewUpgrade(): Promise<void> {
	const phase = useUpdates.getState().brew?.phase;
	if (useUpdates.getState().operation || brewStarting || phase === "running" || phase === "verifying") return;
	brewStarting = true;
	let acquired = false;
	try {
		const command = await window.vomp.invoke("updates:app:beginBrew");
		acquired = true;
		const { homeDir } = await window.vomp.invoke("app:info");
		useUpdates.setState({ operation: "update" });
		const run = await CommandRun.start({ command, cwd: homeDir, cols: 96, rows: 14 });
		useUpdates.setState({ brew: { phase: "running", run } });
		run.attach({ data: () => {}, exit: code => void finishBrewUpgrade(run, code) });
	} catch (error) {
		if (acquired) {
			await window.vomp.invoke("updates:app:brewSettled");
			useUpdates.setState({ operation: null });
		}
		useUpdates.setState({ brew: { phase: "error", message: errorText(error) } });
	} finally {
		brewStarting = false;
	}
}

/** brew replaces the `.app` in place, so reading its Info.plist tells whether a newer version is there. */
async function finishBrewUpgrade(run: CommandRun, code: number): Promise<void> {
	if (code !== 0) {
		useUpdates.setState({ brew: { phase: "failed", run, code } });
		await window.vomp.invoke("updates:app:brewSettled");
		useUpdates.setState({ operation: null });
		return;
	}
	useUpdates.setState({ brew: { phase: "verifying", run } });
	try {
		const installed = await window.vomp.invoke("updates:app:installedVersion");
		useUpdates.setState({
			brew:
				installed.version && installed.newer
					? { phase: "ready", run, version: installed.version }
					: { phase: "unchanged", run, version: installed.version },
		});
	} catch (error) {
		useUpdates.setState({ brew: { phase: "verifyFailed", run, message: errorText(error) } });
	} finally {
		await window.vomp.invoke("updates:app:brewSettled");
		useUpdates.setState({ operation: null });
	}
}

/** The finished download the installer was already opened for, so progress events don't reopen it. */
let handledDownload: string | null = null;

function onDownload(download: AppDownload): void {
	useUpdates.setState(download.state === "downloading" ? { download, installerOpened: false } : { download, operation: null });
	if (download.state !== "done" || handledDownload === download.filePath) return;
	handledDownload = download.filePath;
	if (!download.downloadOnly) void openInstaller();
}

/** Opens the disk image in Finder, or runs the Windows installer after confirming the app may quit. */
export async function openInstaller(): Promise<void> {
	const t = i18n.getFixedT(null, "onboarding");
	if (useUpdates.getState().operation) return;
	if (useUpdates.getState().download?.downloadOnly) return;
	try {
		if (useUpdates.getState().install?.method === "nsis") {
			// True only once runInstaller resolved (it rejects when the installer can't be opened).
			const started = await quitAfterConfirm(() => window.vomp.invoke("updates:app:runInstaller"));
			useUpdates.setState({ installerOpened: started });
		} else {
			await window.vomp.invoke("updates:app:runInstaller");
			useUpdates.setState({ installerOpened: true });
		}
	} catch (error) {
		toast({ tone: "err", message: t("update.app.openFailed"), description: errorText(error) });
	}
}

/** Quits (after the working-chats question) and, with `relaunch`, starts the app again from the same path. */
export async function quitForUpdate(relaunch: boolean): Promise<void> {
	const t = i18n.getFixedT(null, "onboarding");
	try {
		await quitAfterConfirm(() => window.vomp.invoke("updates:app:quit", relaunch));
	} catch (error) {
		toast({ tone: "err", message: t(relaunch ? "update.app.restartFailed" : "update.app.quitFailed"), description: errorText(error) });
	}
}

/** A reconnect counts only when that host generation reports the installed engine. */
function waitForRestart(controller: SessionController, previous: { hostId: string; generation: number }): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	let settled = false;
	const settle = (ok: boolean) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		unsubscribe();
		unsubscribeUpdates();
		resolve(ok);
	};
	const check = () => {
		const view = controller.getSnapshot();
		const host = view.host;
		const installed = useUpdates.getState().installedOmp;
		if (!host || view.mode !== "live" || !installed || (host.hostId === previous.hostId && host.generation <= previous.generation)) return;
		const snapshot = engineSnapshots.get(host.hostId);
		if (snapshot?.asyncJobsGeneration === host.generation && snapshot.ompVersion) settle(snapshot.ompVersion === installed);
	};
	const timer = setTimeout(() => settle(false), RESTART_CONFIRM_MS);
	const unsubscribe = controller.subscribe(check);
	const unsubscribeUpdates = useUpdates.subscribe(check);
	check();
	return promise;
}

/**
 * Restarts idle stale chats only. Work is rechecked at the controller's final submission or stop
 * boundary, and a reconnect must report the installed engine before it counts as successful.
 */
export async function restartStaleChats(): Promise<void> {
	if (useUpdates.getState().restartingChats > 0) return;
	const ids = useUpdates.getState().staleChats;
	if (!ids.length) return;
	// Reserve before the first await, including preparation, so clicks cannot start overlapping batches.
	useUpdates.setState({ restartingChats: ids.length });
	const t = i18n.getFixedT(null, "onboarding");
	let reason: string | null = null;
	try {
		const results = await Promise.all(ids.map(async tabId => {
			const controller = controllerFor(tabId);
			const view = controller?.getSnapshot();
			if (!controller || !view?.host || view.mode === "exited" || view.mode === "history") return "stopped";
			const assertIdle = () => {
				if (workInFlight(controller.getSnapshot())) throw new Error(t("update.omp.busyBody"));
			};
			if (workInFlight(view)) return "busy";
			const previous = { hostId: view.host.hostId, generation: view.host.generation };
			try {
				await controller.restart(assertIdle);
				return await waitForRestart(controller, previous) ? "confirmed" : "failed";
			} catch (error) {
				if (workInFlight(controller.getSnapshot())) return "busy";
				reason = errorText(error);
				return "failed";
			}
		}));
		const installed = useUpdates.getState().installedOmp;
		if (installed) reconcileInstalledOmp(installed);
		const stale = useUpdates.getState().staleChats;
		const confirmed = results.filter((result, index) => result === "confirmed" && !stale.includes(ids[index]!)).length;
		const failed = results.filter(result => result === "failed").length;
		const busy = results.filter(result => result === "busy").length;
		if (confirmed) toast({ tone: "ok", message: t("update.omp.restarted", { count: confirmed }) });
		if (failed) toast({ tone: "err", message: t("update.omp.restartFailed", { count: failed }), description: reason ?? t("update.omp.restartFailedBody") });
		if (busy) toast({ tone: "info", message: t("update.omp.busy", { count: busy }), description: t("update.omp.busyBody") });
	} finally {
		const installed = useUpdates.getState().installedOmp;
		if (installed) reconcileInstalledOmp(installed);
		useUpdates.setState({ restartingChats: 0 });
	}
}

/** Compare the running SDK version, not chat launch times or an updater's exit code. */
export function reconcileInstalledOmp(version: string): void {
	const previous = useUpdates.getState();
	const staleChats = allControllers().filter(controller => {
		const view = controller.getSnapshot();
		const snapshot = view.host && engineSnapshots.get(view.host.hostId);
		if (!view.host || view.mode === "exited" || view.mode === "history") return false;
		if (snapshot?.ompVersion && snapshot.asyncJobsGeneration === view.host.generation) return snapshot.ompVersion !== version;
		return previous.staleChats.includes(controller.tabId);
	}).map(controller => controller.tabId);
	const omp = previous.omp;
	useUpdates.setState({
		installedOmp: version, staleChats,
		...(omp ? { omp: { ...omp, currentVersion: version, updateAvailable: Boolean(omp.latestVersion && compareSemver(omp.latestVersion, version) > 0) } } : {}),
	});
	if (engineNotice && engineNoticeVersion === version && engineNoticeCount !== staleChats.length) {
		engineNoticeCount = staleChats.length;
		updateToast(engineNotice, engineNoticeActions(version, engineNoticeCount));
	}
	checkEngineNotice(version, staleChats.length > 0);
}

function announceAppUpdate(status: AppUpdateStatus): void {
	const t = i18n.getFixedT(null, "onboarding");
	appUpdateNotice = toast({
		tone: "info",
		sticky: true,
		message: t("update.available", { version: status.latestVersion }),
		description: status.summary ?? t("update.availableBody"),
		action: { label: t("update.notes.review"), onClick: () => openReleaseNotes() },
		secondaryAction: { label: t("update.dismiss"), onClick: () => {} },
	});
}

/** Reports whether the restart after an in-app update opened the new version. */
async function reportOutcome(): Promise<void> {
	const t = i18n.getFixedT(null, "onboarding");
	const outcome = await window.vomp.invoke("updates:app:outcome");
	if (!outcome) return;
	if (outcome.operation === "switch") {
		toast({
			tone: outcome.updated ? "ok" : "warn",
			message: t(outcome.failureKind === "cleanup" ? "update.installSwitch.cleanupFailed" : outcome.updated ? "update.installSwitch.succeeded" : "update.installSwitch.failed", { manager: outcome.method === "scoop" ? "Scoop" : "Homebrew" }),
			...(outcome.failure ? { description: outcome.failure } : {}),
		});
		return;
	}
	if (outcome.updated) {
		let rollbackVersion: string | undefined;
		if (compareSemver(outcome.running, outcome.from) > 0) {
			try {
				await Promise.all([
					useUpdates.getState().app ? Promise.resolve() : checkApp(false),
					useUpdates.getState().install ? Promise.resolve() : loadInstall(),
				]);
				const { app, install } = useUpdates.getState();
				rollbackVersion = eligibleRollbackReleases(app, install, outcome.from)[0]?.version;
			} catch { /* The successful update notice remains available when metadata cannot be loaded. */ }
		}
		toast({
			tone: "ok",
			message: t("update.updated", { version: outcome.running }),
			...(rollbackVersion ? { secondaryAction: {
				label: t("update.rollback.toVersion", { version: rollbackVersion, defaultValue: "Roll back to v{{version}}" }),
				onClick: () => openReleaseNotes("past", rollbackVersion),
			} } : {}),
		});
	} else {
		toast({ tone: "warn", message: t("update.notUpdated", { version: outcome.running }), description: t(`update.notUpdatedBody.${outcome.method}`) });
	}
}

/** Registers the update sheet and command and listens for main's checks (shortly after launch, then every 30 minutes). */
export function installUpdateWatchers(): void {
	sheets.register({ id: APP_UPDATE_SHEET, component: lazyView(() => updateSheets().then(module => module.AppUpdateSheet)) });
	sheets.register({ id: RELEASE_NOTES_SHEET, component: lazyView(() => updateSheets().then(module => module.ReleaseNotesSheet)) });
	sheets.register({ id: OMP_NOTES_SHEET, component: lazyView(() => updateSheets().then(module => module.OmpNotesSheet)) });
	registerCommand({
		id: "app.checkUpdates",
		title: "onboarding:update.check.title",
		hint: "onboarding:update.check.hint",
		keywords: "onboarding:update.check.keywords",
		group: "settings",
		icon: ArrowsClockwise,
		run: () => {
			openSettings("about");
			void checkForUpdates();
		},
	});

	const announced = new Set<string>();
	window.vomp.on("updates:app", status => {
		useUpdates.setState({ app: status });
		if (!status.updateAvailable || !status.latestVersion || announced.has(status.latestVersion)) return;
		announced.add(status.latestVersion);
		announceAppUpdate(status);
	});
	window.vomp.on("updates:omp", omp => {
		useUpdates.setState({ omp });
		const installed = useUpdates.getState().installedOmp;
		if (installed) reconcileInstalledOmp(installed);
	});
	window.vomp.on("updates:app:operation", operation => useUpdates.setState({ operation }));
	window.vomp.on("updates:app:download", onDownload);
	const onInstalled = (version: string) => {
		const changed = useUpdates.getState().installedOmp !== version;
		reconcileInstalledOmp(version);
		if (changed) void useApp.getState().refreshOmp();
		if (!changed) return;
		for (const controller of allControllers()) {
			const host = controller.getSnapshot().host;
			if (!host) continue;
			void window.vomp.invoke("native:snapshot", host.hostId).then(snapshot => {
				if (!snapshot) return;
				engineSnapshots.set(host.hostId, snapshot);
				if (useUpdates.getState().installedOmp === version) reconcileInstalledOmp(version);
			}).catch(() => {});
		}
	};
	window.vomp.on("updates:omp:installed", ({ version }) => onInstalled(version));
	window.vomp.on("native:changed", ({ hostId, snapshot }) => {
		engineSnapshots.set(hostId, snapshot);
		const version = useUpdates.getState().installedOmp;
		if (version) reconcileInstalledOmp(version);
	});
	window.vomp.on("host:state", () => {
		const version = useUpdates.getState().installedOmp;
		if (version) queueMicrotask(() => reconcileInstalledOmp(version));
	});
	void window.vomp.invoke("updates:omp:installed").then(version => { if (version) onInstalled(version); }).catch(() => {});
	void reportOutcome();
}

/** A successful command still needs to install a supported version before setup can finish. */
export function ompUpdateState(run: OmpUpdateRun | null, error: string | null, minimum?: string): "running" | "busy" | "failed" | "unsupported" | "done" {
	if (error) return "failed";
	if (!run || run.finishedAt === null) return "running";
	if (run.installBusy) return "busy";
	if (run.exitCode !== 0) return "failed";
	if (minimum && (!run.versionAfter || compareSemver(run.versionAfter, minimum) < 0)) return "unsupported";
	return "done";
}

