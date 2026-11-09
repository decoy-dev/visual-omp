import { ArrowSquareOut, ArrowUp, ArrowsClockwise, CircleDashed, Copy, Minus, ShieldWarning, Sparkle, WarningDiamond, Wrench } from "@phosphor-icons/react";
import { type MouseEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppDownload, AppUpdateStatus } from "@shared/contracts/updates";
import { eligibleRollbackReleases } from "@shared/rollback";
import { parseChangelog } from "@shared/changelog";
import { isReleaseHighlightCategory, parseReleaseHighlights } from "@shared/releaseHighlights";
import { type ReleaseNotesEntry, releaseNotesForVersions } from "@shared/releaseNotes";
import { compareSemver } from "@shared/semver";
import type { AppInstallInfo } from "@shared/contracts/updates";
import changelog from "../../../../../CHANGELOG.md?raw";
import { Button, Dialog, DialogContent, PresenceSwap, Progress, Select, SelectItem, Tabs, TabsContent, TabsList, TabsTrigger, toast } from "../../ui";
import { renderReleaseInlineMarkdown, renderReleaseMarkdown } from "./releaseMarkdown";
import "./releaseNotes.css";

const bundled = parseChangelog(changelog);
const RELEASES_URL = "https://github.com/decoy-dev/visual-omp/releases";
const highlightIcons = { Security: ShieldWarning, New: Sparkle, Improved: ArrowUp, Changed: ArrowsClockwise, Fixed: Wrench, Removed: Minus };
export type ReleaseNotesView = "pending" | "past";

export interface ReleaseNotesViewerProps {
	status: AppUpdateStatus | null;
	installedVersion: string | null;
	initialView?: ReleaseNotesView;
	installInfo?: AppInstallInfo | null;
	initialVersion?: string;
	download?: AppDownload | null;
	busy?: boolean;
	open: boolean;
	onExited(): void;
	close(): void;
	onUpdate(): void;
	onRollback(version: string, downloadOnly?: boolean): Promise<void>;
}

/** A bounded update decision, with the installed version's history available in the same window. */
export function ReleaseNotesViewer({ status, installedVersion, installInfo, initialView = "pending", initialVersion, download, open, onExited, close, onUpdate, onRollback, busy = false }: ReleaseNotesViewerProps) {
	const { t } = useTranslation("onboarding");
	const currentVersion = status?.currentVersion ?? installedVersion;
	const skipThrough = status?.skippedThroughVersion && currentVersion && compareSemver(status.skippedThroughVersion, currentVersion) > 0 ? status.skippedThroughVersion : currentVersion;
	const pendingVersion = status?.updateAvailable ? status.latestVersion : null;
	const notes = useMemo(() => {
		// Earlier caches contain only the newest body. Keep it readable until a fresh check completes.
		const published = status?.releases?.length ? status.releases : status?.latestVersion ? [{
			version: status.latestVersion, body: status.notes ?? "", url: status.releaseUrl, publishedAt: status.publishedAt,
		}] : [];
		return releaseNotesForVersions(currentVersion ?? "", pendingVersion, published, bundled);
	}, [status, currentVersion, pendingVersion]);
	const [requestedView, setView] = useState<ReleaseNotesView>(initialView);
	const view = pendingVersion ? requestedView : "past";
	const [selectedPast, setSelectedPast] = useState<string | null>(initialVersion ?? null);
	const past = notes.past.find(entry => entry.version === selectedPast) ?? notes.past[0];
	const [confirmVersion, setConfirmVersion] = useState<string | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const rollbackButton = useRef<HTMLButtonElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	useLayoutEffect(() => {
		(confirmOpen ? cancelButton : rollbackButton).current?.focus();
	}, [confirmOpen]);
	const publishedPast = past && status?.releases?.find(release => release.version.replace(/^v/, "") === past.version);
	const eligible = !!past && eligibleRollbackReleases(status, installInfo).some(release => release.version.replace(/^v/, "") === past.version);
	const managed = installInfo?.method === "brew" || installInfo?.method === "scoop";
	const installer = installInfo?.method === "dmg" || installInfo?.method === "nsis";
	const confirm = async () => {
		if (!confirmVersion || starting || busy || !eligibleRollbackReleases(status, installInfo).some(release => release.version.replace(/^v/, "") === confirmVersion)) return;
		setStarting(true);
		setStartError(null);
		try {
			await onRollback(confirmVersion, managed);
			setConfirmOpen(false);
		} catch (error) {
			setStartError(error instanceof Error ? error.message : String(error));
		} finally {
			setStarting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={next => {
			if (next || starting) return;
			if (confirmOpen) setConfirmOpen(false);
			else close();
		}}>
			<DialogContent
				size={confirmOpen ? "lg" : "xl"}
				title={confirmOpen ? t("update.rollback.title", { version: confirmVersion }) : t("update.notes.title")}
				description={confirmOpen ? t("update.rollback.description", { from: currentVersion, to: confirmVersion }) : pendingVersion ? t("update.notes.pendingDescription", { from: currentVersion, to: pendingVersion }) : t("update.notes.pastDescription")}
				onCloseAutoFocus={onExited}
				hideClose={starting}
				footer={confirmOpen ? <>
					<Button ref={cancelButton} variant="ghost" disabled={starting} onClick={() => setConfirmOpen(false)}>{t("update.rollback.cancel")}</Button>
					<Button variant="primary" disabled={busy || !eligible} loading={starting} onClick={() => void confirm()}>{t(managed ? "update.rollback.download" : "update.notes.installEarlier", { version: confirmVersion })}</Button>
				</> : <>
					<Button variant="ghost" icon={<ArrowSquareOut />} onClick={() => void window.vomp.invoke("app:openExternal", RELEASES_URL)}>{t("update.notes.allReleases")}</Button>
					<Button variant="ghost" onClick={close}>{t("update.app.close")}</Button>
					{view === "pending" && pendingVersion && <Button variant="primary" disabled={busy} onClick={onUpdate}>{t("update.notes.install", { version: pendingVersion })}</Button>}
					{view === "past" && eligible && (installer || managed) && past && <Button ref={rollbackButton} disabled={busy} variant="primary" onClick={() => { setStartError(null); setConfirmVersion(past.version); setConfirmOpen(true); }}>{t(managed ? "update.rollback.download" : "update.notes.installEarlier", { version: past.version })}</Button>}
				</>}
			>
				{confirmOpen ? <div className="flex flex-col gap-stack text-md text-fg-muted">
					<p>{t(managed ? "update.rollback.managedConfirmation" : "update.rollback.preserved")}</p>
					<p>{t(confirmVersion && compareSemver(confirmVersion, "0.7.1") < 0 ? managed ? "update.rollback.managedLegacySkip" : "update.rollback.legacySkip" : "update.rollback.skip", { version: skipThrough })}</p>
					<p>{t(managed ? "update.rollback.managedLead" : installInfo?.method === "nsis" ? "update.rollback.nsis" : "update.rollback.dmg")}</p>
					{startError && <p role="alert" className="text-err">{t("update.app.download.failed", { reason: startError })}</p>}
				</div> : <>
				{status?.error && <p role="status" className="mb-stack text-sm text-fg-muted">{t("update.notes.offline")}</p>}
				{status?.skippedThroughVersion && <p role="status" className="mb-card text-sm text-fg-muted">{t("update.rollback.skipped", { version: status.skippedThroughVersion })}</p>}
				<Tabs value={view} onValueChange={next => setView(next as ReleaseNotesView)}>
					<TabsList aria-label={t("update.notes.browse")} className="mb-card">
						{pendingVersion && <TabsTrigger value="pending">{t("update.notes.pending")}</TabsTrigger>}
						<TabsTrigger value="past">{t("update.notes.past")}</TabsTrigger>
					</TabsList>
					<TabsContent value="pending">
						{notes.pending.length > 1 && <p className="mb-card text-sm text-fg-muted">{t("update.notes.included", { count: notes.pending.length })}</p>}
						{notes.pending.length ? notes.pending.map(entry => <ReleaseEntry key={entry.version} entry={entry} installed={false} />) : <p className="py-card text-fg-muted">{t("update.notes.empty")}</p>}
					</TabsContent>
					<TabsContent value="past">
						{notes.past.length > 0 && <div className="mb-card flex flex-wrap items-center gap-toolbar">
							<label htmlFor="release-notes-version" className="text-sm text-fg-muted">{t("update.notes.version")}</label>
							<Select id="release-notes-version" value={past?.version} onValueChange={setSelectedPast} className="min-w-40">
								{notes.past.map(entry => <SelectItem key={entry.version} value={entry.version} hint={entry.version === currentVersion ? t("update.notes.installed") : undefined}>v{entry.version}</SelectItem>)}
							</Select>
						</div>}
						<PresenceSwap swapKey={past?.version ?? "empty"}>
							{past ? <ReleaseEntry entry={past} installed={past.version === currentVersion} /> : <p className="py-card text-fg-muted">{t(currentVersion ? "update.notes.empty" : "update.notes.loading")}</p>}
						</PresenceSwap>
						{managed && publishedPast?.platformAsset && !eligible && currentVersion && past && compareSemver(past.version, currentVersion) < 0 && <p role="status" className="mt-card text-sm text-fg-muted">{t("update.rollback.digestUnavailable")}</p>}
						{eligible && managed && installInfo && past && <ManagedRollbackSteps key={past.version} method={installInfo.method as "brew" | "scoop"} version={past.version} global={installInfo.scoopGlobal} retained={installInfo.scoopRetainedVersions?.includes(past.version) ?? false} download={download?.version === past.version && download.downloadOnly ? download : null} />}
					</TabsContent>
				</Tabs>
				</>}
			</DialogContent>
		</Dialog>
	);
}

export function ManagedRollbackSteps({ method, version, global, retained, download }: { method: "brew" | "scoop"; version: string; global: boolean; retained: boolean; download?: AppDownload | null }) {
	const { t } = useTranslation("onboarding");
	return (
		<div className="mt-card border-t border-border pt-card text-sm text-fg-muted">
			<p>{t("update.rollback.managedLead")}</p>
			<p className="mt-stack">{t("update.rollback.managedPreserved")}</p>
			{download && <div role="status" className="mt-card">
				{download.state === "downloading" ? <>
					<p className="mb-row">{t("update.rollback.downloading", { version })}</p>
					<Progress value={download.total ? download.received / download.total * 100 : undefined} showValue aria-label={t("update.app.download.label", { file: download.fileName })} />
					<Button size="sm" variant="ghost" className="mt-row" onClick={() => void window.vomp.invoke("updates:app:cancelDownload")}>{t("update.app.download.cancel")}</Button>
				</> : download.state === "done" ? <p className="text-ok">{t("update.rollback.downloaded", { path: download.filePath })}</p>
					: <p className="text-err">{t(download.state === "cancelled" ? "update.app.download.cancelled" : "update.app.download.failed", { reason: download.error })}</p>}
			</div>}
			<ol className="mt-card list-decimal space-y-stack pl-5">
				<li>{t(method === "brew" ? "update.rollback.brewQuit" : global ? "update.rollback.scoopGlobalQuit" : "update.rollback.scoopQuit")}
					<RollbackCommand command={method === "brew" ? "brew uninstall --cask visual-omp" : `scoop uninstall visual-omp${global ? " --global" : ""}`} />
				</li>
				<li>{t(method === "brew" ? "update.rollback.brewInstall" : "update.rollback.scoopInstall")}</li>
			</ol>
			<p className="mt-card">{t(method === "brew" ? "update.rollback.brewReturn" : "update.rollback.scoopReturn")}</p>
			<RollbackCommand command={method === "brew" ? "brew install --cask decoy-dev/tap/visual-omp" : "scoop install visual-omp"} />
			{method === "scoop" && retained && <div className="mt-card">
				<p>{t("update.rollback.scoopRetained", { version })}</p>
				<RollbackCommand command={`scoop reset visual-omp@${version}${global ? " --global" : ""}`} />
			</div>}
		</div>
	);
}

function RollbackCommand({ command }: { command: string }) {
	const { t } = useTranslation("onboarding");
	const copy = () => void navigator.clipboard.writeText(command).then(
		() => toast({ tone: "ok", message: t("update.reinstall.copied") }),
		error => toast({ tone: "err", message: t("update.reinstall.copyFailed", { reason: String(error) }) }),
	);
	return <div className="mt-row">
		<code className="block select-all whitespace-pre-wrap break-all rounded-md border border-border bg-inset px-3 py-2 font-mono text-sm text-fg">{command}</code>
		<Button size="sm" variant="ghost" icon={<Copy aria-hidden />} className="mt-row" onClick={copy}>{t("update.reinstall.copy")}</Button>
	</div>;
}

function ReleaseEntry({ entry, installed }: { entry: ReleaseNotesEntry; installed: boolean }) {
	const { t, i18n } = useTranslation("onboarding");
	const highlights = useMemo(() => parseReleaseHighlights(entry.body), [entry.body]);
	const html = useMemo(() => highlights ? null : renderReleaseMarkdown(entry.body), [entry.body, highlights]);
	const categoryLabel = (category: string) => isReleaseHighlightCategory(category) ? t(`update.notes.categories.${category}`) : category;
	const date = entry.publishedAt !== null && Number.isFinite(entry.publishedAt)
		? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(entry.publishedAt) : null;
	const openLink = (event: MouseEvent<HTMLDivElement>) => {
		const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
		if (!anchor) return;
		event.preventDefault();
		const href = anchor.getAttribute("href");
		if (!href || (event.type === "auxclick" && event.button !== 1)) return;
		try {
			const url = new URL(href, entry.url ?? `${RELEASES_URL}/tag/v${entry.version}`);
			if (["https:", "http:", "mailto:"].includes(url.protocol)) void window.vomp.invoke("app:openExternal", url.href);
		} catch { /* Invalid links remain inert. */ }
	};
	return (
		<article className="min-w-0 border-b border-border pb-section last:border-0 last:pb-0 [&+article]:pt-section">
			<header className="mb-stack flex flex-wrap items-baseline gap-x-toolbar gap-y-1">
				<h2 className="text-lg font-semibold text-fg">v{entry.version}</h2>
				{installed && <span className="text-sm text-fg-muted">{t("update.notes.installed")}</span>}
				{date && <span className="text-sm text-fg-muted">{date}</span>}
			</header>
			{entry.source === "bundled" && <p className="mb-stack text-sm text-fg-muted">{t("update.notes.bundled")}</p>}
			{entry.body ? <div className="break-words" onClick={openLink} onAuxClick={openLink}>
				{highlights ? <div className="release-summary">
					{highlights.overview && <ReleaseMarkdown source={highlights.overview} />}
					{highlights.notice && <div role="note" className={`release-notice ${["IMPORTANT", "WARNING", "CAUTION"].includes(highlights.notice.kind) ? "release-notice-warning" : ""}`}>
						<WarningDiamond className="size-5 shrink-0" aria-hidden />
						<div className="min-w-0">
							<p className="font-semibold">{t(`update.notes.notices.${highlights.notice.kind}`)}</p>
							<ReleaseMarkdown source={highlights.notice.body} />
						</div>
					</div>}
					<section className="release-highlights">
						<h3 className="sr-only">{t("update.notes.highlights")}</h3>
						{highlights.headlines.length > 0 && <section>
							<h4 className="sr-only">{t("update.notes.spotlight")}</h4>
							<ul className="release-spotlights">
								{highlights.headlines.map((item, index) => <li key={index} className="release-spotlight">
									<HighlightIcon category={item.category} spotlight />
									<div className="min-w-0">
										<span className="sr-only">{categoryLabel(item.category)}: </span>
										<p className="text-lg font-semibold text-fg" dangerouslySetInnerHTML={{ __html: renderReleaseInlineMarkdown(item.title!.slice(0, -1)) }} />
										<ReleaseMarkdown source={item.body} className="release-spotlight-body" />
									</div>
								</li>)}
							</ul>
						</section>}
						{highlights.groups.map((group, index) => <section key={index} className="release-group">
							<h4 className="release-group-heading">
								<HighlightIcon category={group.category} />
								<span>{categoryLabel(group.category)}<span className="font-normal text-fg-muted"> · {group.items.length}</span></span>
							</h4>
							<ul className="release-group-items">
								{group.items.map((item, index) => <li key={index}><ReleaseMarkdown source={item.body} /></li>)}
							</ul>
						</section>)}
						{highlights.remaining && <ReleaseMarkdown source={highlights.remaining} />}
					</section>
					{highlights.detailed && <ReleaseMarkdown source={highlights.detailed} />}
				</div> : <div className="tr-md" dangerouslySetInnerHTML={{ __html: html! }} />}
			</div> : <p className="text-fg-muted">{t("update.notes.empty")}</p>}
			{entry.url && <Button size="sm" variant="ghost" className="mt-card" icon={<ArrowSquareOut />} onClick={() => void window.vomp.invoke("app:openExternal", entry.url!)}>{t("update.notes.onGitHub")}</Button>}
		</article>
	);
}

function ReleaseMarkdown({ source, className = "" }: { source: string; className?: string }) {
	const html = useMemo(() => renderReleaseMarkdown(source), [source]);
	return <div className={`tr-md release-highlight-copy ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function HighlightIcon({ category, spotlight = false }: { category: string; spotlight?: boolean }) {
	const Icon = isReleaseHighlightCategory(category) ? highlightIcons[category] : CircleDashed;
	return <span aria-hidden className={`release-category-icon ${spotlight ? "release-category-icon-large" : ""} ${category === "Security" ? "release-category-security" : ""}`}>
		<Icon className={spotlight ? "size-4" : "size-3"} aria-hidden />
	</span>;
}
