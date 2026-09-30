/**
 * Update surfaces (DESIGN §4.22). Settings → About is the one place for updates: it shows both
 * versions, runs the checks and starts either update. A toast announces a new visual-omp release.
 * The app update runs in {@link AppUpdateSheet}: `brew upgrade --cask` in a terminal for Homebrew
 * installs, otherwise the installer downloads to ~/Downloads and opens. The omp update streams in
 * {@link OmpUpdateSheet}, after which open chats can be restarted onto the new omp.
 */
import { ArrowsClockwise } from "@phosphor-icons/react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { AppDownload, AppInstallInfo, AppUpdateStatus, OmpUpdateRun, OmpUpdateStatus } from "@shared/contracts/updates";
import { i18n } from "../../i18n";
import { registerCommand } from "../../registry/commands";
import { useSheetPresence } from "../../registry/sheetPresence";
import { type SheetProps, sheets } from "../../registry/slots";
import { allControllers, controllerFor, useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { Button, Dialog, DialogContent, PresenceSwap, Progress, toast, WorkingIndicator } from "../../ui";
import { ipcErrorMessage as errorText } from "../manage/shared";
import { formatBytes } from "../projects/format";
import { InlineTerminal } from "./InlineTerminal";
import { quitAfterConfirm } from "./quit";
import { CommandRun } from "./terminal";

export const OMP_UPDATE_SHEET = "onboarding.ompUpdate";
export const APP_UPDATE_SHEET = "onboarding.appUpdate";

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
	install: AppInstallInfo | null;
	checkingApp: boolean;
	checkingOmp: boolean;
	brew: BrewUpgrade | null;
	download: AppDownload | null;
	/** The downloaded installer was opened: the disk image in Finder, or the NSIS installer (the app then quits). */
	installerOpened: boolean;
	/** Chat tabs whose omp started before the last successful `omp update`. */
	staleChats: readonly string[];
	/** Chats sent /restart that haven't reconnected yet. */
	restartingChats: number;
}

export const useUpdates = create<UpdatesState>(() => ({
	app: null,
	omp: null,
	install: null,
	checkingApp: false,
	checkingOmp: false,
	brew: null,
	download: null,
	installerOpened: false,
	staleChats: [],
	restartingChats: 0,
}));

/** Latest `omp update --check` result (status bar omp chip). Null until the first check finishes. */
export function useOmpUpdateStatus(): OmpUpdateStatus | null {
	return useUpdates(state => state.omp);
}

async function checkApp(force: boolean): Promise<void> {
	useUpdates.setState({ checkingApp: true });
	try {
		useUpdates.setState({ app: await window.vomp.invoke("updates:app:check", force) });
	} finally {
		useUpdates.setState({ checkingApp: false });
	}
}

async function checkOmp(force: boolean): Promise<void> {
	useUpdates.setState({ checkingOmp: true });
	try {
		useUpdates.setState({ omp: await window.vomp.invoke("updates:omp:check", force) });
	} finally {
		useUpdates.setState({ checkingOmp: false });
	}
}

async function loadInstall(): Promise<AppInstallInfo> {
	const install = await window.vomp.invoke("updates:app:install");
	useUpdates.setState({ install });
	return install;
}

/** Checks visual-omp and omp now, bypassing main's 6-hour cache. */
export async function checkForUpdates(): Promise<void> {
	await Promise.all([checkApp(true), checkOmp(true), loadInstall()]);
}

/** Loads the last results (main's 6-hour cache), checking only what is stale. */
export async function loadUpdates(): Promise<void> {
	await Promise.all([checkApp(false), checkOmp(false), loadInstall()]);
}

/**
 * Starts the visual-omp update the way this copy was installed: Homebrew upgrade, installer
 * download, or (development builds, other platforms) the release page in the browser.
 */
export async function startAppUpdate(): Promise<void> {
	const t = i18n.getFixedT(null, "onboarding");
	const { app } = useUpdates.getState();
	if (!app?.updateAvailable) return;
	const install = useUpdates.getState().install ?? (await loadInstall());
	const useInstaller = install.method === "dmg" || install.method === "nsis";
	if (install.method === "manual" || (useInstaller && !app.platformAsset)) {
		if (app.releaseUrl) void window.vomp.invoke("app:openExternal", app.releaseUrl);
		return;
	}
	if (install.method === "brew") void startBrewUpgrade();
	else {
		handledDownload = null;
		try {
			onDownload(await window.vomp.invoke("updates:app:download"));
		} catch (error) {
			toast({ tone: "err", message: t("update.app.download.startFailed"), description: errorText(error) });
			return;
		}
	}
	useApp.getState().openSheet(APP_UPDATE_SHEET);
}

/** Set while the brew run is being started, so a second click can't start another. */
let brewStarting = false;

async function startBrewUpgrade(): Promise<void> {
	const phase = useUpdates.getState().brew?.phase;
	if (brewStarting || phase === "running" || phase === "verifying") return;
	brewStarting = true;
	try {
		const [{ command }, { homeDir }] = await Promise.all([loadInstall(), window.vomp.invoke("app:info")]);
		if (!command) return;
		const run = await CommandRun.start({ command, cwd: homeDir, cols: 96, rows: 14 });
		useUpdates.setState({ brew: { phase: "running", run } });
		run.attach({ data: () => {}, exit: code => void finishBrewUpgrade(run, code) });
	} catch (error) {
		useUpdates.setState({ brew: { phase: "error", message: errorText(error) } });
	} finally {
		brewStarting = false;
	}
}

/** brew replaces the `.app` in place, so reading its Info.plist tells whether a newer version is there. */
async function finishBrewUpgrade(run: CommandRun, code: number): Promise<void> {
	if (code !== 0) {
		useUpdates.setState({ brew: { phase: "failed", run, code } });
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
	}
}

/** The finished download the installer was already opened for, so progress events don't reopen it. */
let handledDownload: string | null = null;

function onDownload(download: AppDownload): void {
	useUpdates.setState(download.state === "downloading" ? { download, installerOpened: false } : { download });
	if (download.state !== "done" || handledDownload === download.filePath) return;
	handledDownload = download.filePath;
	void openInstaller();
}

/** Opens the disk image in Finder, or runs the Windows installer after confirming the app may quit. */
export async function openInstaller(): Promise<void> {
	const t = i18n.getFixedT(null, "onboarding");
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

/** Resolves true once the chat's omp is live again on a newer host generation, false if it stops or times out. */
function waitForRestart(controller: SessionController, generation: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	let settled = false;
	const settle = (ok: boolean) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		unsubscribe();
		resolve(ok);
	};
	const check = () => {
		const view = controller.getSnapshot();
		if (view.mode === "exited") settle(false);
		else if (view.mode === "live" && (view.host?.generation ?? 0) > generation) settle(true);
	};
	const timer = setTimeout(() => settle(false), RESTART_CONFIRM_MS);
	const unsubscribe = controller.subscribe(check);
	check();
	return promise;
}

/**
 * Sends /restart (the header's "Restart omp") to every chat that was running when omp updated, and
 * counts a chat as restarted only once it reconnects. Chats in the middle of a reply are skipped;
 * they and any chat whose restart failed stay listed.
 */
export async function restartStaleChats(): Promise<void> {
	if (useUpdates.getState().restartingChats > 0) return;
	const t = i18n.getFixedT(null, "onboarding");
	const busy: string[] = [];
	const failed: string[] = [];
	const pending: Promise<{ tabId: string; ok: boolean }>[] = [];
	let reason: string | null = null;
	for (const tabId of useUpdates.getState().staleChats) {
		const controller = controllerFor(tabId);
		const view = controller?.getSnapshot();
		// Closed or stopped chats start the new omp the next time they run.
		if (!controller || !view?.host || view.mode === "exited" || view.mode === "history") continue;
		if (view.working) {
			busy.push(tabId);
			continue;
		}
		const generation = view.host.generation;
		try {
			await controller.restart();
			pending.push(waitForRestart(controller, generation).then(ok => ({ tabId, ok })));
		} catch (error) {
			failed.push(tabId);
			reason = errorText(error);
		}
	}
	useUpdates.setState({ restartingChats: pending.length });
	const results = await Promise.all(pending);
	const confirmed = results.filter(result => result.ok).length;
	for (const result of results) if (!result.ok) failed.push(result.tabId);
	useUpdates.setState({ restartingChats: 0, staleChats: [...busy, ...failed] });
	if (confirmed > 0) toast({ tone: "ok", message: t("update.omp.restarted", { count: confirmed }) });
	if (failed.length > 0) {
		toast({ tone: "err", message: t("update.omp.restartFailed", { count: failed.length }), description: reason ?? t("update.omp.restartFailedBody") });
	}
	if (busy.length > 0) toast({ tone: "info", message: t("update.omp.busy", { count: busy.length }), description: t("update.omp.busyBody") });
}

function announceAppUpdate(status: AppUpdateStatus): void {
	const t = i18n.getFixedT(null, "onboarding");
	toast({
		tone: "info",
		sticky: true,
		message: t("update.available", { version: status.latestVersion }),
		description: status.summary ?? t("update.availableBody"),
		action: { label: t("update.update"), onClick: () => void startAppUpdate() },
		secondaryAction: { label: t("update.dismiss"), onClick: () => {} },
	});
}

/** Reports whether the restart after an in-app update opened the new version. */
async function reportOutcome(): Promise<void> {
	const t = i18n.getFixedT(null, "onboarding");
	const outcome = await window.vomp.invoke("updates:app:outcome");
	if (!outcome) return;
	if (outcome.updated) toast({ tone: "ok", message: t("update.updated", { version: outcome.running }) });
	else toast({ tone: "warn", message: t("update.notUpdated", { version: outcome.running }), description: t("update.notUpdatedBody") });
}

/** Registers the update sheet and command and listens for main's checks (main runs them every 6 hours). */
export function installUpdateWatchers(): void {
	sheets.register({ id: APP_UPDATE_SHEET, component: AppUpdateSheet });
	registerCommand({
		id: "app.checkUpdates",
		title: "onboarding:update.check.title",
		hint: "onboarding:update.check.hint",
		keywords: "onboarding:update.check.keywords",
		group: "settings",
		icon: ArrowsClockwise,
		run: () => {
			useApp.getState().openSheet("settings", { tab: "about" });
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
	window.vomp.on("updates:omp", omp => useUpdates.setState({ omp }));
	window.vomp.on("updates:app:download", onDownload);
	window.vomp.on("updates:omp:finished", run => {
		const before = useUpdates.getState().omp?.currentVersion ?? null;
		const changed = run.exitCode === 0 && !run.args.includes("--plugins") && (!before || !run.versionAfter || before !== run.versionAfter);
		if (changed) {
			const running = allControllers().filter(controller => {
				const view = controller.getSnapshot();
				return view.host !== null && view.mode !== "exited" && view.mode !== "history";
			});
			useUpdates.setState({ staleChats: running.map(controller => controller.tabId) });
		}
	});
	void reportOutcome();
}

function BrewProgress({ brew }: { brew: BrewUpgrade }) {
	const { t } = useTranslation("onboarding");
	const status =
		brew.phase === "running" ? (
			<WorkingIndicator label={t("update.app.brew.running")} />
		) : brew.phase === "verifying" ? (
			<WorkingIndicator label={t("update.app.brew.verifying")} />
		) : brew.phase === "ready" ? (
			<StatusLine ok text={t("update.app.brew.ready", { version: brew.version })} />
		) : brew.phase === "failed" ? (
			<StatusLine text={t("update.app.brew.failed", { code: brew.code })} />
		) : brew.phase === "unchanged" ? (
			<StatusLine text={brew.version ? t("update.app.brew.unchanged", { version: brew.version }) : t("update.app.brew.unknown")} />
		) : brew.phase === "verifyFailed" ? (
			<StatusLine text={t("update.app.brew.verifyFailed", { reason: brew.message })} />
		) : (
			<StatusLine text={t("update.app.brew.startFailed", { reason: brew.message })} />
		);
	return (
		<>
			<div role="status" className="mb-3 text-md">
				<PresenceSwap swapKey={brew.phase} className="flex items-center gap-2">
					{status}
				</PresenceSwap>
			</div>
			{brew.phase !== "error" && <InlineTerminal run={brew.run} label={t("update.app.brew.terminalLabel")} className="h-60" screenReader />}
			{brew.phase === "ready" && <p className="mt-3 text-sm text-fg-muted">{t("update.app.brew.gatekeeper")}</p>}
		</>
	);
}

function DownloadProgress({ download, method }: { download: AppDownload; method: AppInstallInfo["method"] }) {
	const { t } = useTranslation("onboarding");
	const installerOpened = useUpdates(state => state.installerOpened);
	if (download.state === "downloading") {
		const percent = download.total ? (download.received / download.total) * 100 : undefined;
		return (
			<div className="flex flex-col gap-2">
				<Progress value={percent} showValue aria-label={t("update.app.download.label", { file: download.fileName })} />
				<p className="font-mono text-xs tabular-nums text-fg-faint">
					{download.total
						? t("update.app.download.bytes", { received: formatBytes(download.received), total: formatBytes(download.total) })
						: formatBytes(download.received)}
				</p>
			</div>
		);
	}
	if (download.state === "failed") return <StatusLine text={t("update.app.download.failed", { reason: download.error ?? "" })} />;
	if (download.state === "cancelled") return <StatusLine text={t("update.app.download.cancelled")} />;
	return (
		<div className="flex flex-col gap-2 text-md">
			<div className="flex items-center gap-2">
				<StatusLine ok text={t("update.app.download.saved", { path: download.filePath })} />
				{method === "dmg" && (
					<Button size="sm" variant="ghost" className="ml-auto shrink-0" onClick={() => void window.vomp.invoke("app:showItem", download.filePath)}>
						{t("update.app.dmg.showInFinder")}
					</Button>
				)}
			</div>
			<p className="text-fg-muted">
				{method === "nsis"
					? t(installerOpened ? "update.app.nsis.starting" : "update.app.nsis.ready")
					: t(installerOpened ? "update.app.dmg.steps" : "update.app.dmg.stepsClosed")}
			</p>
		</div>
	);
}

function StatusLine({ text, ok = false }: { text: string; ok?: boolean }) {
	return (
		<span className="flex items-center gap-2">
			{ok ? <CheckCircle className="size-4 shrink-0 text-ok" aria-hidden /> : <WarningCircle className="size-4 shrink-0 text-err" aria-hidden />}
			<span className="text-fg">{text}</span>
		</span>
	);
}

/** The visual-omp update in progress: Homebrew terminal, or installer download and next steps. */
export function AppUpdateSheet({ close }: SheetProps<undefined>) {
	const { t } = useTranslation("onboarding");
	const presence = useSheetPresence();
	const app = useUpdates(state => state.app);
	const install = useUpdates(state => state.install);
	const brew = useUpdates(state => state.brew);
	const download = useUpdates(state => state.download);
	const installerOpened = useUpdates(state => state.installerOpened);
	const method = install?.method ?? "manual";

	let body: ReactNode = null;
	let actions: ReactNode = null;
	if (method === "brew" && brew) {
		body = <BrewProgress brew={brew} />;
		if (brew.phase === "ready") {
			actions = (
				<Button variant="primary" onClick={() => void quitForUpdate(true)}>
					{t("update.app.restart")}
				</Button>
			);
		} else if (brew.phase === "failed" || brew.phase === "unchanged" || brew.phase === "verifyFailed" || brew.phase === "error") {
			actions = <Button onClick={() => void startBrewUpgrade()}>{t("update.app.retry")}</Button>;
		}
	} else if ((method === "dmg" || method === "nsis") && download) {
		body = <DownloadProgress download={download} method={method} />;
		if (download.state === "downloading") {
			actions = <Button onClick={() => void window.vomp.invoke("updates:app:cancelDownload")}>{t("update.app.download.cancel")}</Button>;
		} else if (download.state === "failed" || download.state === "cancelled") {
			actions = <Button onClick={() => void startAppUpdate()}>{t("update.app.retry")}</Button>;
		} else if (method === "dmg") {
			actions = (
				<>
					<Button onClick={() => void openInstaller()}>{t("update.app.dmg.open")}</Button>
					<Button variant="primary" onClick={() => void quitForUpdate(false)}>
						{t("update.app.quit")}
					</Button>
				</>
			);
		} else if (!installerOpened) {
			actions = (
				<Button variant="primary" onClick={() => void openInstaller()}>
					{t("update.app.nsis.run")}
				</Button>
			);
		}
	}

	return (
		<Dialog open={presence.open} onOpenChange={open => !open && close()}>
			<DialogContent
				onCloseAutoFocus={presence.exited}
				size="lg"
				title={app?.latestVersion ? t("update.app.title", { version: app.latestVersion }) : t("update.app.titleGeneric")}
				description={app?.summary ?? undefined}
				footer={
					<>
						{actions}
						<Button variant="ghost" onClick={close}>
							{t("update.app.close")}
						</Button>
					</>
				}
			>
				{body ?? <WorkingIndicator label={t("update.app.preparing")} />}
				{app?.releaseUrl && (
					<button
						type="button"
						className="mt-3 text-sm text-accent underline-offset-2 hover:underline"
						onClick={() => void window.vomp.invoke("app:openExternal", app.releaseUrl ?? "")}
					>
						{t("update.app.releaseNotes")}
					</button>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Runs `omp update` (or attaches to a run already in progress) and streams its output. */
export function OmpUpdateSheet({ close }: SheetProps<undefined>) {
	const { t } = useTranslation("onboarding");
	const presence = useSheetPresence();
	const [run, setRun] = useState<OmpUpdateRun | null>(null);
	const [error, setError] = useState<string | null>(null);
	const staleChats = useUpdates(state => state.staleChats.length);
	const restartingChats = useUpdates(state => state.restartingChats);
	const output = useRef<HTMLPreElement>(null);

	useEffect(() => {
		let current: OmpUpdateRun | null = null;
		const earlyOutput = new Map<string, string[]>();
		const earlyFinished = new Map<string, OmpUpdateRun>();
		const offOutput = window.vomp.on("updates:omp:output", chunk => {
			if (!current) {
				earlyOutput.set(chunk.runId, [...(earlyOutput.get(chunk.runId) ?? []), chunk.data]);
				return;
			}
			if (chunk.runId !== current.runId) return;
			current = { ...current, output: current.output + chunk.data };
			setRun(current);
		});
		const offFinished = window.vomp.on("updates:omp:finished", finished => {
			if (!current) {
				earlyFinished.set(finished.runId, finished);
				return;
			}
			if (finished.runId !== current.runId) return;
			current = finished;
			setRun(finished);
			void useApp.getState().refreshOmp();
		});
		void (async () => {
			const last = await window.vomp.invoke("updates:omp:lastRun");
			// StrictMode remounts reuse the run the first mount started (main returns the active run).
			current = last && last.finishedAt === null ? last : await window.vomp.invoke("updates:omp:run");
			const outputBeforeAttach = earlyOutput.get(current.runId)?.join("") ?? "";
			if (outputBeforeAttach && !current.output.includes(outputBeforeAttach)) {
				current = { ...current, output: current.output + outputBeforeAttach };
			}
			const finishedBeforeAttach = earlyFinished.get(current.runId);
			if (finishedBeforeAttach) current = finishedBeforeAttach;
			setRun(current);
			if (finishedBeforeAttach) void useApp.getState().refreshOmp();
		})().catch((failure: unknown) => setError(errorText(failure)));
		return () => {
			offOutput();
			offFinished();
		};
	}, []);

	useEffect(() => {
		const element = output.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [run?.output]);

	const running = !error && (!run || run.finishedAt === null);
	const failed = Boolean(error) || (run?.exitCode !== null && run?.exitCode !== undefined && run.exitCode !== 0);
	const latest = useUpdates.getState().omp?.latestVersion;

	return (
		<Dialog open={presence.open} onOpenChange={open => !open && close()}>
			<DialogContent
				onCloseAutoFocus={presence.exited}
				size="lg"
				title={latest ? t("update.omp.titleTo", { version: latest }) : t("update.omp.title")}
				footer={
					<>
						{!running && !failed && staleChats > 0 && (
							<Button variant="primary" loading={restartingChats > 0} onClick={() => void restartStaleChats()}>
								{t("update.omp.restartChats")}
							</Button>
						)}
						<Button variant={running || staleChats > 0 ? "ghost" : "primary"} onClick={close}>
							{t("update.omp.close")}
						</Button>
					</>
				}
			>
				<div role="status" className="mb-3 text-md">
					<PresenceSwap swapKey={running ? "running" : failed ? "failed" : "done"} className="flex items-center gap-2">
						{running ? (
							<WorkingIndicator label={t("update.omp.running")} />
						) : failed ? (
							<StatusLine text={error ?? t("update.omp.failed", { code: run?.exitCode })} />
						) : (
							<StatusLine ok text={run?.versionAfter ? t("update.omp.doneVersion", { version: run.versionAfter }) : t("update.omp.done")} />
						)}
					</PresenceSwap>
				</div>
				<pre
					ref={output}
					aria-label={t("update.omp.outputLabel")}
					tabIndex={0}
					className="h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-inset p-3 font-mono text-sm text-fg"
				>
					{run?.output || t("update.omp.waiting")}
				</pre>
				{!running && !failed && staleChats > 0 && (
					<p role="status" className="mt-3 text-sm text-fg-muted">
						{restartingChats > 0
							? t("update.omp.restarting", { count: restartingChats })
							: t("update.omp.restartNote", { count: staleChats })}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
