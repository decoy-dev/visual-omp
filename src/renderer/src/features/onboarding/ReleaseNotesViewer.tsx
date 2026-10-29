import { ArrowSquareOut } from "@phosphor-icons/react";
import { type MouseEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppUpdateStatus } from "@shared/contracts/updates";
import { parseChangelog } from "@shared/changelog";
import { type ReleaseNotesEntry, releaseNotesForVersions } from "@shared/releaseNotes";
import changelog from "../../../../../CHANGELOG.md?raw";
import { Button, Dialog, DialogContent, PresenceSwap, Select, SelectItem, Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui";
import { renderReleaseMarkdown } from "./releaseMarkdown";

const bundled = parseChangelog(changelog);
const RELEASES_URL = "https://github.com/decoy-dev/visual-omp/releases";
export type ReleaseNotesView = "pending" | "past";

interface Props {
	status: AppUpdateStatus | null;
	installedVersion: string | null;
	initialView?: ReleaseNotesView;
	open: boolean;
	onExited(): void;
	close(): void;
	onUpdate(): void;
}

/** A bounded update decision, with the installed version's history available in the same window. */
export function ReleaseNotesViewer({ status, installedVersion, initialView = "pending", open, onExited, close, onUpdate }: Props) {
	const { t } = useTranslation("onboarding");
	const currentVersion = status?.currentVersion ?? installedVersion;
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
	const [selectedPast, setSelectedPast] = useState<string | null>(null);
	const past = notes.past.find(entry => entry.version === selectedPast) ?? notes.past[0];

	return (
		<Dialog open={open} onOpenChange={next => !next && close()}>
			<DialogContent
				size="xl"
				title={t("update.notes.title")}
				description={pendingVersion ? t("update.notes.pendingDescription", { from: currentVersion, to: pendingVersion }) : t("update.notes.pastDescription")}
				onCloseAutoFocus={onExited}
				footer={<>
					<Button variant="ghost" icon={<ArrowSquareOut />} onClick={() => void window.vomp.invoke("app:openExternal", RELEASES_URL)}>{t("update.notes.allReleases")}</Button>
					<Button variant="ghost" onClick={close}>{t("update.app.close")}</Button>
					{view === "pending" && pendingVersion && <Button variant="primary" onClick={onUpdate}>{t("update.notes.install", { version: pendingVersion })}</Button>}
				</>}
			>
				{status?.error && <p role="status" className="mb-stack text-sm text-fg-muted">{t("update.notes.offline")}</p>}
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
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

function ReleaseEntry({ entry, installed }: { entry: ReleaseNotesEntry; installed: boolean }) {
	const { t, i18n } = useTranslation("onboarding");
	const html = useMemo(() => renderReleaseMarkdown(entry.body), [entry.body]);
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
			{entry.body ? <div className="tr-md break-words" onClick={openLink} onAuxClick={openLink} dangerouslySetInnerHTML={{ __html: html }} /> : <p className="text-fg-muted">{t("update.notes.empty")}</p>}
			{entry.url && <Button size="sm" variant="ghost" className="mt-card" icon={<ArrowSquareOut />} onClick={() => void window.vomp.invoke("app:openExternal", entry.url!)}>{t("update.notes.onGitHub")}</Button>}
		</article>
	);
}
