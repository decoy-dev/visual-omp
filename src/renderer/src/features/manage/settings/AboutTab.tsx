import { ArrowsClockwise, ArrowSquareOut, Bug } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	APP_UPDATE_SHEET,
	checkForUpdates,
	loadUpdates,
	OMP_UPDATE_SHEET,
	quitForUpdate,
	restartStaleChats,
	startAppUpdate,
	useUpdates,
} from "@/features/onboarding/updates";
import { useApp } from "@/state/app";
import { Button, Mark, PresenceSwap, Spinner, Wordmark } from "@/ui";
import { useResource } from "../shared";

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

export function AboutTab() {
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
		if (download?.state === "downloading" && download.version === app?.latestVersion) {
			const percent = download.total ? Math.round((download.received / download.total) * 100) : null;
			return {
				text: percent === null ? t("about.downloading") : t("about.downloadingPercent", { percent }),
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
				action: { label: t("about.updateApp"), primary: true, run: () => void startAppUpdate() },
			};
		}
		return { text: t("about.upToDate"), tone: "ok" };
	})();

	const ompRow = ((): StatusRow => {
		const status = updates.omp;
		if (updates.checkingOmp) return { text: t("about.checking"), tone: "busy" };
		if (!status) return { text: t("about.notChecked"), tone: "accent" };
		if (status.error) return { text: t("about.checkFailed", { reason: status.error }), tone: "err" };
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
			<div className="flex items-center gap-4">
				<Mark size={48} />
				<div>
					<Wordmark size="lg" />
					<p className="mt-1 text-sm text-fg-muted">{t("about.tagline")}</p>
				</div>
			</div>

			<dl className="mt-6 grid grid-cols-[140px_1fr] gap-x-4 gap-y-3 rounded-lg border border-border bg-panel p-4 text-md">
				<dt className="text-fg-muted">{t("about.appVersion")}</dt>
				<dd className="min-w-0">
					<p className="text-fg">
						<span className="font-mono">{info.data ? t("about.version", { version: info.data.version }) : "…"}</span>
						{updates.install && <span className="text-fg-muted"> · {t(`about.method.${updates.install.method}`)}</span>}
					</p>
					<StatusLine row={appRow} />
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
				{updates.app?.releaseUrl && (
					<Button variant="ghost" icon={<ArrowSquareOut />} onClick={() => open(updates.app?.releaseUrl ?? "")}>
						{t("about.releaseNotes")}
					</Button>
				)}
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
		<div role="status" className="mt-1.5 min-h-7 text-sm text-fg-muted">
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
