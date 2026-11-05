/**
 * The update sheets (DESIGN §4.22), loaded on first open or in idle time: the visual-omp update in
 * {@link AppUpdateSheet}, the omp update in {@link OmpUpdateSheet} and the release notes. Their state,
 * checks and actions stay in `./updates`, which loads with the app.
 */
import { CheckCircle, Copy, WarningCircle } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppDownload, AppInstallInfo, OmpUpdateRun } from "@shared/contracts/updates";
import { lazyView } from "../../registry/lazy";
import { useSheetPresence } from "../../registry/sheetPresence";
import type { SheetProps } from "../../registry/slots";
import { useApp } from "../../state/app";
import { Button, Dialog, DialogContent, Expand, PageSkeleton, PresenceSwap, Progress, toast, WorkingIndicator } from "../../ui";
import { focusRing } from "../../ui/styles";
import { ipcErrorMessage as errorText, useResource } from "../manage/shared";
import { formatBytes } from "../projects/format";
import { InlineTerminal } from "./InlineTerminal";
import { PackageManagerSuggestion, ScoopSuggestion } from "./PackageManagerSwitch";
import type { ReleaseNotesView, ReleaseNotesViewerProps } from "./ReleaseNotesViewer";
import {
	type BrewUpgrade, loadInstall, ompUpdateState, openInstaller, openReleaseNotes, quitForUpdate, restartStaleChats,
	retryAppDownload, startAppRollback, startAppUpdate, startBrewUpgrade, useUpdates,
} from "./updates";

/** The changelog text and its viewer load on first use or in idle time, outside the startup chunk. */
const ReleaseNotesViewer = lazyView(() => import("./ReleaseNotesViewer").then(module => module.ReleaseNotesViewer), ReleaseNotesLoading);

/** The notes dialog's frame while its chunk loads; closing it still reports the exit to the sheet host. */
function ReleaseNotesLoading({ open, onExited, close }: ReleaseNotesViewerProps) {
	const { t } = useTranslation("onboarding");
	return (
		<Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
			<DialogContent size="xl" title={t("update.notes.title")} onCloseAutoFocus={onExited}>
				<PageSkeleton />
			</DialogContent>
		</Dialog>
	);
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


const SCOOP_GLOBAL_COMMAND = "scoop update visual-omp --global";

/** Scoop installs for all users: updating needs an administrator PowerShell, which the app never starts itself. */
function ScoopGlobalSteps() {
	const { t } = useTranslation("onboarding");
	const copy = () =>
		void navigator.clipboard.writeText(SCOOP_GLOBAL_COMMAND).then(
			() => toast({ tone: "ok", message: t("update.app.scoop.globalCopied") }),
			error => toast({ tone: "err", message: t("update.app.scoop.globalCopyFailed"), description: errorText(error) }),
		);
	return (
		<div className="text-md">
			<p className="text-fg-muted">{t("update.app.scoop.global")}</p>
			<code className="mt-2 block select-all break-all rounded-md border border-border bg-inset px-3 py-2 font-mono text-sm text-fg">
				{SCOOP_GLOBAL_COMMAND}
			</code>
			<Button size="sm" variant="ghost" icon={<Copy aria-hidden />} className="mt-2" onClick={copy}>
				{t("update.app.scoop.globalCopy")}
			</Button>
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

export function ReleaseNotesSheet({ close, props }: SheetProps<{ view?: ReleaseNotesView }>) {
	const presence = useSheetPresence();
	const status = useUpdates(state => state.app);
	const installInfo = useUpdates(state => state.install);
	const busy = useUpdates(state => !!state.operation);
	useEffect(() => { if (!useUpdates.getState().install) void loadInstall(); }, []);
	const info = useResource(() => window.vomp.invoke("app:info"), []);
	return <ReleaseNotesViewer
		status={status}
		installedVersion={info.data?.version ?? null}
		installInfo={installInfo}
		busy={busy}
		initialView={props?.view}
		open={presence.open}
		onExited={presence.exited}
		close={close}
		onUpdate={() => { close(); void startAppUpdate(); }}
		onRollback={startAppRollback}
	/>;
}

/** The visual-omp update in progress: Homebrew terminal, or installer download and next steps. */
export function AppUpdateSheet({ close }: SheetProps<undefined>) {
	const { t } = useTranslation("onboarding");
	const presence = useSheetPresence();
	const app = useUpdates(state => state.app);
	const install = useUpdates(state => state.install);
	const brew = useUpdates(state => state.brew);
	const download = useUpdates(state => state.download);
	const downloadTarget = useUpdates(state => state.downloadTarget);
	const downloadOperation = useUpdates(state => state.downloadOperation);
	const installerOpened = useUpdates(state => state.installerOpened);
	const switchRunning = useUpdates(state => state.operation === "switch");
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
	} else if (method === "scoop" && install?.scoopGlobal) {
		body = <ScoopGlobalSteps />;
	} else if (method === "scoop") {
		body = <p className="text-md text-fg-muted">{t("update.app.scoop.body")}</p>;
		actions = (
			<Button variant="primary" onClick={() => void quitForUpdate(true)}>
				{t("update.app.scoop.restart")}
			</Button>
		);
	} else if ((method === "dmg" || method === "nsis") && download) {
		body = <DownloadProgress download={download} method={method} />;
		if (download.state === "downloading") {
			actions = <Button onClick={() => void window.vomp.invoke("updates:app:cancelDownload")}>{t("update.app.download.cancel")}</Button>;
		} else if (download.state === "failed" || download.state === "cancelled") {
			actions = <Button onClick={() => void retryAppDownload()}>{t(downloadOperation === "reinstall" ? "update.reinstall.retry" : downloadOperation === "rollback" ? "update.rollback.retry" : "update.app.retry")}</Button>;
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
				title={downloadTarget ? t(downloadOperation === "reinstall" ? "update.reinstall.progressTitle" : "update.rollback.progressTitle", { version: downloadTarget }) : app?.latestVersion ? t("update.app.title", { version: app.latestVersion }) : t("update.app.titleGeneric")}
				description={downloadTarget ? t(downloadOperation === "reinstall" ? "update.reinstall.progressDescription" : "update.rollback.progressDescription", { version: downloadTarget }) : app?.summary ?? undefined}
				footer={
					<>
						<fieldset disabled={switchRunning} className="contents">{actions}</fieldset>
						<Button variant="ghost" onClick={close}>
							{t("update.app.close")}
						</Button>
					</>
				}
			>
				{body ?? <WorkingIndicator label={t("update.app.preparing")} />}
				<button
					type="button"
					className="mt-3 text-sm text-accent underline-offset-2 hover:underline"
					onClick={() => openReleaseNotes(downloadTarget ? "past" : "pending")}
				>
					{t("update.app.releaseNotes")}
				</button>
				{method === "nsis" ? <ScoopSuggestion /> : method === "dmg" && <PackageManagerSuggestion />}
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
	const minimum = useApp(state => state.omp?.minVersion);
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

	const state = ompUpdateState(run, error, minimum);
	const running = state === "running";
	const failed = state === "failed" || state === "unsupported";
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
					<PresenceSwap swapKey={state} className="flex items-center gap-2">
						{running ? (
							<WorkingIndicator label={t("update.omp.running")} />
						) : state === "unsupported" ? (
							<StatusLine text={t("update.omp.unsupported", { version: minimum })} />
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
