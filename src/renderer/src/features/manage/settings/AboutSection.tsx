import { ArrowsClockwise, ArrowSquareOut, Bug, Copy } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	APP_UPDATE_SHEET,
	checkForUpdates,
	loadUpdates,
	OMP_UPDATE_SHEET,
	quitForUpdate,
	restartStaleChats,
	openReleaseNotes,
	startAppReinstall,
	useUpdates,
} from "@/features/onboarding/updates";
import { useApp } from "@/state/app";
import { Button, Dialog, DialogContent, Mark, PageHeader, PresenceSwap, Spinner, Wordmark } from "@/ui";
import { ipcErrorMessage, useResource } from "../shared";

const DOCS_URL = "https://omp.sh";
const ISSUES_URL = "https://github.com/decoy-dev/visual-omp/issues";
/** Re-render the "last check" time this often. */
const CLOCK_MS = 30_000;

type Tone = "ok" | "accent" | "err";

interface StatusRow {
	text: string;
	tone: Tone | "busy";
	action?: { label: string; primary?: boolean; run(): void };
}

export function AboutSection() {
	const { t, i18n } = useTranslation("manage");
	const info = useResource(() => window.vomp.invoke("app:info"), []);
	const omp = useApp(state => state.omp);
	const updates = useUpdates();
	const [now, setNow] = useState(Date.now);

	useEffect(() => {
		void loadUpdates();
		const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
		return () => clearInterval(timer);
	}, []);

	const open = (url: string) => void window.vomp.invoke("app:openExternal", url);
	const openSheet = (id: string) => useApp.getState().openSheet(id);
	const checking = updates.checkingApp || updates.checkingOmp;

	const appRow = ((): StatusRow => {
		const { app, brew, download } = updates;
		if (updates.checkingApp) return { text: t("about.checking"), tone: "busy" };
		if (brew?.phase === "running" || brew?.phase === "verifying") {
			return { text: t("about.brewRunning"), tone: "busy", action: { label: t("about.showProgress"), run: () => openSheet(APP_UPDATE_SHEET) } };
		}
		if (brew?.phase === "ready") {
			return {
				text: t("about.brewReady", { version: brew.version }),
				tone: "accent",
				action: { label: t("about.restartApp"), primary: true, run: () => void quitForUpdate(true) },
			};
		}
		if (download?.state === "downloading") {
			const percent = download.total ? Math.round((download.received / download.total) * 100) : null;
			return {
				text: t("onboarding:update.rollback.aboutDownloading", { version: download.version, progress: percent === null ? "" : ` (${percent}%)` }),
				tone: "busy",
				action: { label: t("about.showProgress"), run: () => openSheet(APP_UPDATE_SHEET) },
			};
		}
		if (!app) return { text: t("about.notChecked"), tone: "accent" };
		if (app.error) return { text: t("about.checkFailed", { reason: app.error }), tone: "err" };
		if (app.updateAvailable) {
			return {
				text: t("about.appUpdate", { version: app.latestVersion }),
				tone: "accent",
				action: { label: t("onboarding:update.notes.review"), primary: true, run: () => openReleaseNotes() },
			};
		}
		return { text: t("about.upToDate"), tone: "ok" };
	})();

	const ompRow = ((): StatusRow => {
		const status = updates.omp;
		if (updates.checkingOmp) return { text: t("about.checking"), tone: "busy" };
		if (!status) return { text: t("about.notChecked"), tone: "accent" };
		if (status.error) return { text: t("about.checkFailed", { reason: status.error }), tone: "err" };
		if (status.managedBy) return { text: t("about.ompManaged", { app: status.managedBy }), tone: "ok" };
		if (status.updateAvailable) {
			return {
				text: t("about.ompUpdate", { version: status.latestVersion }),
				tone: "accent",
				action: { label: t("about.updateOmp"), primary: true, run: () => openSheet(OMP_UPDATE_SHEET) },
			};
		}
		return { text: t("about.upToDate"), tone: "ok" };
	})();

	const checkedAt = Math.max(updates.app?.checkedAt ?? 0, updates.omp?.checkedAt ?? 0);
	const channel = updates.omp?.channel;
	const ompVersion = omp?.version ?? updates.omp?.currentVersion;

	return (
		<div>
			<PageHeader title={t("settings.sections.about")} description={t("about.tagline")} />
			<div className="flex items-center gap-4">
				<Mark size={48} />
				<Wordmark size="lg" />
			</div>

			<dl className="mt-6 grid grid-cols-[2.1875rem_1fr] gap-x-4 gap-y-3 rounded-lg border border-border bg-panel p-4 text-md">
				<dt className="text-fg-muted">{t("about.appVersion")}</dt>
				<dd className="min-w-0">
					<p className="text-fg">
						<span className="font-mono">{info.data ? t("about.version", { version: info.data.version }) : "…"}</span>
						{updates.install && <span className="text-fg-muted"> · {t(`about.method.${updates.install.method}`)}</span>}
					</p>
					<StatusLine row={appRow} />
					{updates.app?.skippedThroughVersion && <p className="mt-stack text-sm text-fg-muted">{t("onboarding:update.rollback.skipped", { version: updates.app.skippedThroughVersion })}</p>}
					<ReinstallAction busy={updates.download?.state === "downloading" || updates.brew?.phase === "running" || updates.brew?.phase === "verifying"} />
				</dd>

				<dt className="text-fg-muted">{t("about.ompVersion")}</dt>
				<dd className="min-w-0">
					<p className="text-fg">
						<span className="font-mono">{ompVersion ? t("about.version", { version: ompVersion }) : t("about.ompMissing")}</span>
						{channel && <span className="text-fg-muted"> · {t(`about.channel.${channel}`)}</span>}
					</p>
					<StatusLine row={ompRow} />
					{updates.restartingChats > 0 ? (
						<StatusLine row={{ text: t("about.restartingChats", { count: updates.restartingChats }), tone: "busy" }} />
					) : (
						updates.staleChats.length > 0 && (
							<StatusLine
								row={{
									text: t("about.staleChats", { count: updates.staleChats.length }),
									tone: "accent",
									action: { label: t("about.restartChats"), run: () => void restartStaleChats() },
								}}
							/>
						)
					)}
				</dd>

				{omp?.path && (
					<>
						<dt className="text-fg-muted">{t("about.ompPath")}</dt>
						<dd className="truncate font-mono text-sm text-fg-muted" title={omp.path}>
							{omp.path}
						</dd>
					</>
				)}

				<dt className="text-fg-muted">{t("about.lastCheck")}</dt>
				<dd className="text-fg">{checkedAt > 0 ? relativeTime(checkedAt, now, i18n.language, t("about.justNow")) : t("about.never")}</dd>
			</dl>

			<div className="mt-4 flex flex-wrap items-center gap-2">
				<Button variant="primary" icon={<ArrowsClockwise />} loading={checking} onClick={() => void checkForUpdates()}>
					{t("about.checkUpdates")}
				</Button>
				<Button variant="ghost" onClick={() => openReleaseNotes(updates.app?.updateAvailable ? "pending" : "past")}>
					{t("about.releaseNotes")}
				</Button>
				<Button variant="ghost" icon={<ArrowSquareOut />} onClick={() => open(DOCS_URL)}>
					{t("about.docs")}
				</Button>
				<Button variant="ghost" icon={<Bug />} onClick={() => open(ISSUES_URL)}>
					{t("about.reportIssue")}
				</Button>
			</div>
		</div>
	);
}

/** Availability is read from fresh release metadata, independently of the cached update offer. */
function ReinstallAction({ busy }: { busy: boolean }) {
	const { t } = useTranslation("onboarding");
	const availability = useResource(async () => {
		const [reinstall, install] = await Promise.all([
			window.vomp.invoke("updates:app:reinstallInfo"),
			window.vomp.invoke("updates:app:install"),
		]);
		return { reinstall, install };
	}, []);
	const [confirmation, setConfirmation] = useState<typeof availability.data>(null);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const handedOff = useRef(false);
	const cancel = useRef<HTMLButtonElement>(null);
	const action = useRef<HTMLButtonElement>(null);
	const data = availability.data;
	const managed = confirmation?.install.method === "brew" || confirmation?.install.method === "scoop";
	const available = data?.reinstall.available && (
		data.install.method === "dmg" || data.install.method === "nsis" ||
		((data.install.method === "brew" || data.install.method === "scoop") && !!data.reinstall.command)
	);
	const confirm = async () => {
		if (!confirmation || managed || starting) return;
		setStarting(true);
		setStartError(null);
		try {
			await startAppReinstall(confirmation.reinstall.version);
			handedOff.current = true;
			setConfirmation(null);
		} catch (error) {
			setStartError(t("update.reinstall.startFailed", { reason: ipcErrorMessage(error) }));
		} finally {
			setStarting(false);
		}
	};
	const copy = async () => {
		if (!confirmation?.reinstall.command) return;
		try {
			await navigator.clipboard.writeText(confirmation.reinstall.command);
			setCopied(true);
			setStartError(null);
		} catch (error) {
			setStartError(t("update.reinstall.copyFailed", { reason: ipcErrorMessage(error) }));
		}
	};

	return <>
		<div className="mt-stack flex flex-wrap items-center gap-toolbar">
			<Button
				ref={action}
				size="sm"
				disabled={availability.loading || !!availability.error || !available || busy}
				onClick={() => { handedOff.current = false; setCopied(false); setStartError(null); setConfirmation(data); }}
			>
				{data?.install.method === "brew" ? t("update.reinstall.brewTitle") : data?.install.method === "scoop" ? t("update.reinstall.scoopTitle") : data ? t("update.reinstall.action", { version: data.reinstall.version }) : t("update.reinstall.actionGeneric")}
			</Button>
			{availability.loading ? <span role="status" className="text-sm text-fg-muted">{t("update.reinstall.checking")}</span> :
				(availability.error || !available) && <>
					<span role="status" className="text-sm text-fg-muted">
						{availability.error ? t("update.reinstall.checkFailed", { reason: availability.error }) : t(`update.reinstall.unavailable.${data?.reinstall.reason ?? "unsupported"}`)}
					</span>
					<Button size="sm" variant="ghost" onClick={() => void availability.reload()}>{t("update.reinstall.checkAgain")}</Button>
				</>}
		</div>
		<Dialog open={!!confirmation} onOpenChange={open => { if (!open && !starting) setConfirmation(null); }}>
			<DialogContent
				size="lg"
				title={managed ? t(confirmation?.install.method === "brew" ? "update.reinstall.brewTitle" : "update.reinstall.scoopTitle") : t("update.reinstall.title", { version: confirmation?.reinstall.version })}
				description={t(managed ? "update.reinstall.managerDescription" : "update.reinstall.description", { version: confirmation?.reinstall.version })}
				hideClose={starting}
				onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus(); }}
				onCloseAutoFocus={event => { event.preventDefault(); if (!handedOff.current) action.current?.focus(); }}
				footer={<>
					<Button ref={cancel} variant="ghost" disabled={starting} onClick={() => setConfirmation(null)}>{t(managed ? "update.app.close" : "update.rollback.cancel")}</Button>
					{managed ? <Button variant="primary" icon={<Copy aria-hidden />} onClick={() => void copy()}>{t(copied ? "update.reinstall.copied" : "update.reinstall.copy")}</Button> :
						<Button variant="primary" loading={starting} onClick={() => void confirm()}>{t("update.reinstall.action", { version: confirmation?.reinstall.version })}</Button>}
				</>}
			>
				<div className="flex flex-col gap-stack text-md text-fg-muted">
					<p>{t(managed ? "update.reinstall.managerPreserved" : "update.reinstall.preserved")}</p>
					{managed ? <>
						<p>{t(confirmation?.install.method === "brew" ? "update.reinstall.brew" : "update.reinstall.scoop")}</p>
						<p>{t("update.reinstall.managerSkip")}</p>
						<p>{t(confirmation?.install.method === "brew" ? "update.reinstall.brewRun" : confirmation?.install.scoopGlobal ? "update.reinstall.scoopGlobal" : "update.reinstall.scoopRun")}</p>
						<code className="block select-all whitespace-pre-wrap break-all rounded-md border border-border bg-inset px-3 py-2 font-mono text-sm text-fg">{confirmation?.reinstall.command}</code>
					</> : <p>{t(confirmation?.install.method === "nsis" ? "update.reinstall.nsis" : "update.reinstall.dmg")}</p>}
					{startError && <p role="alert" className="text-err">{startError}</p>}
				</div>
			</DialogContent>
		</Dialog>
	</>;
}

/** "5 minutes ago", "2 hours ago"; under a minute reads `justNow`. */
function relativeTime(at: number, now: number, language: string, justNow: string): string {
	const seconds = Math.round((at - now) / 1000);
	if (Math.abs(seconds) < 60) return justNow;
	const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
	const minutes = Math.round(seconds / 60);
	if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (Math.abs(hours) < 24) return format.format(hours, "hour");
	return format.format(Math.round(hours / 24), "day");
}

const DOTS: Record<Tone, string> = { ok: "bg-ok", accent: "bg-accent", err: "bg-err" };

/** The status text crossfades when it changes (checking → up to date); the live region itself stays mounted. */
function StatusLine({ row }: { row: StatusRow }): ReactNode {
	return (
		<div role="status" className="mt-2 min-h-7 text-sm text-fg-muted">
			<PresenceSwap swapKey={`${row.tone}:${row.text}`} className="flex min-h-7 items-center gap-2">
				{row.tone === "busy" ? <Spinner size={12} /> : <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOTS[row.tone]}`} />}
				<span className={row.tone === "err" ? "min-w-0 flex-1 text-err" : "min-w-0 flex-1"}>{row.text}</span>
				{row.action && (
					<Button size="sm" variant={row.action.primary ? "primary" : "secondary"} onClick={row.action.run}>
						{row.action.label}
					</Button>
				)}
			</PresenceSwap>
		</div>
	);
}
