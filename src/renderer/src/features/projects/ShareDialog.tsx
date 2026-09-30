/**
 * Share dialog (DESIGN §4.20): an encrypted read-only link, a standalone web page, or a live
 * invite through omp's public relay (see `@shared/contracts/collab`).
 */
import type { ShareLinkResult } from "@shared/contracts/share";
import type { Participant } from "@oh-my-pi/pi-wire";
import { Check, Copy, FileDown, Link2, Radio, Users } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "@/registry/slots";
import { useSessionView } from "@/shell/hooks";
import { controllerFor, focusedTabId, useApp } from "@/state/app";
import { Button, Chip, Dialog, DialogContent, IconButton, Input, Segmented, StatusDot, Switch, toast } from "@/ui";
import { errorText } from "./actions";
import { useShares } from "./share-store";

export type ShareTab = "link" | "file" | "invite";

export interface ShareProps {
	tabId?: string | null;
	tab?: ShareTab;
}

/** The app's own mirror joins every room as a guest under this name (SessionController). */
const APP_GUEST_NAME = "visual-omp";

export function ShareDialog({ props, close }: SheetProps<ShareProps | undefined>): ReactNode {
	const { t } = useTranslation("projects");
	const tabId = useApp(state => props?.tabId ?? focusedTabId(state));
	const controller = controllerFor(tabId);
	const view = useSessionView(controller);
	const [tab, setTab] = useState<ShareTab>(props?.tab ?? "link");
	const sessionFile = controller?.sessionFile ?? null;

	return (
		<Dialog open onOpenChange={open => !open && close()}>
			<DialogContent size="md" className="w-[520px]" title={t("share.title")}>
				<Segmented<ShareTab>
					aria-label={t("share.kind")}
					className="mb-4"
					value={tab}
					onValueChange={setTab}
					options={[
						{ value: "link", label: t("share.tabs.link"), icon: <Link2 /> },
						{ value: "file", label: t("share.tabs.file"), icon: <FileDown /> },
						{ value: "invite", label: t("share.tabs.invite"), icon: <Users /> },
					]}
				/>
				{!controller ? (
					<p className="text-md text-fg-muted">{t("share.noChat")}</p>
				) : tab === "link" ? (
					<LinkPanel sessionFile={sessionFile} />
				) : tab === "file" ? (
					<FilePanel sessionFile={sessionFile} />
				) : (
					<InvitePanel hostId={view?.host?.phase === "live" ? view.host.hostId : null} participants={view?.guest?.state?.participants ?? []} />
				)}
			</DialogContent>
		</Dialog>
	);
}

function CopyField({ label, value, description }: { label: string; value: string; description?: string }): ReactNode {
	const { t } = useTranslation("projects");
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		await navigator.clipboard.writeText(value);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};
	return (
		<Input
			label={label}
			description={description}
			value={value}
			readOnly
			onFocus={event => event.currentTarget.select()}
			boxClassName="pr-1"
			className="[&_input]:font-mono [&_input]:text-sm"
			trailing={
				<IconButton
					size="sm"
					label={copied ? t("share.copied") : t("share.copy")}
					icon={copied ? <Check className="text-ok" /> : <Copy />}
					onClick={() => void copy()}
				/>
			}
		/>
	);
}

function NeedsMessage(): ReactNode {
	const { t } = useTranslation("projects");
	return <p className="rounded-md border border-border bg-inset px-3 py-2 text-sm text-fg-muted">{t("share.needsMessage")}</p>;
}

function LinkPanel({ sessionFile }: { sessionFile: string | null }): ReactNode {
	const { t } = useTranslation("projects");
	const [gist, setGist] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<ShareLinkResult | null>(null);
	const create = async () => {
		if (!sessionFile) return;
		setBusy(true);
		try {
			setResult(await window.vomp.invoke("share:link", sessionFile, { gist }));
		} catch (error) {
			toast({ tone: "err", message: t("share.link.failed"), description: errorText(error) });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-4">
			<p className="text-md text-fg-muted">{t("share.link.explainer")}</p>
			{!sessionFile ? (
				<NeedsMessage />
			) : result ? (
				<>
					<CopyField label={t("share.link.ready")} value={result.url} description={result.truncated ? t("share.link.truncated") : undefined} />
					{result.gistUrl && <CopyField label={t("share.link.gist")} value={result.gistUrl} />}
				</>
			) : (
				<>
					<Switch label={t("share.link.gistToggle")} description={t("share.link.gistHint")} checked={gist} onCheckedChange={setGist} />
					<div className="flex justify-end">
						<Button variant="primary" icon={<Link2 />} loading={busy} onClick={() => void create()}>
							{t("share.link.create")}
						</Button>
					</div>
				</>
			)}
		</div>
	);
}

function FilePanel({ sessionFile }: { sessionFile: string | null }): ReactNode {
	const { t } = useTranslation("projects");
	const [busy, setBusy] = useState(false);
	const exportFile = async () => {
		if (!sessionFile) return;
		setBusy(true);
		try {
			const path = await window.vomp.invoke("share:exportHtml", sessionFile);
			if (path) {
				toast({
					tone: "ok",
					message: t("share.file.saved"),
					description: path,
					action: { label: t("share.file.reveal"), onClick: () => void window.vomp.invoke("app:showItem", path) },
				});
			}
		} catch (error) {
			toast({ tone: "err", message: t("share.file.failed"), description: errorText(error) });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-4">
			<p className="text-md text-fg-muted">{t("share.file.explainer")}</p>
			{!sessionFile ? (
				<NeedsMessage />
			) : (
				<div className="flex items-center justify-between gap-3">
					<span className="text-sm text-fg-faint">{t("share.file.note")}</span>
					<Button variant="primary" icon={<FileDown />} loading={busy} onClick={() => void exportFile()}>
						{t("share.file.export")}
					</Button>
				</div>
			)}
		</div>
	);
}

/** People in the room besides the host and this app's own mirror. */
export function visitors(participants: readonly Participant[]): Participant[] {
	let skippedSelf = false;
	return participants.filter(participant => {
		if (participant.role === "host") return false;
		if (!skippedSelf && participant.name === APP_GUEST_NAME && !participant.readOnly) {
			skippedSelf = true;
			return false;
		}
		return true;
	});
}

function InvitePanel({ hostId, participants }: { hostId: string | null; participants: readonly Participant[] }): ReactNode {
	const { t } = useTranslation("projects");
	const share = useShares(state => (hostId ? state.byHost[hostId] : undefined));
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (hostId) void useShares.getState().load(hostId);
	}, [hostId]);

	if (!hostId) return <p className="text-md text-fg-muted">{t("share.invite.notLive")}</p>;

	const on = share !== undefined && share.phase !== "stopped";
	const start = async () => {
		setBusy(true);
		try {
			await useShares.getState().start(hostId);
		} catch (error) {
			toast({ tone: "err", message: t("share.invite.failed"), description: errorText(error) });
		} finally {
			setBusy(false);
		}
	};
	const stop = async () => {
		setBusy(true);
		try {
			await window.vomp.invoke("collab:unpublish", hostId);
		} finally {
			setBusy(false);
		}
	};
	const guests = visitors(participants);

	return (
		<div className="flex flex-col gap-4">
			<p className="text-md text-fg-muted">{t("share.invite.explainer")}</p>
			{!on ? (
				<>
					<div className="flex items-center gap-2 rounded-md border border-border bg-inset px-3 py-2 text-sm text-fg-muted">
						<StatusDot status="idle" label={t("share.invite.off")} />
						<span className="flex-1">
							{share?.endedReason === "room-closed" ? t("share.invite.endedRestart") : share?.error ? share.error : t("share.invite.off")}
						</span>
					</div>
					<p className="text-sm text-fg-faint">{t("share.invite.privacy")}</p>
					<div className="flex justify-end">
						<Button variant="primary" icon={<Radio />} loading={busy} onClick={() => void start()}>
							{t("share.invite.start")}
						</Button>
					</div>
				</>
			) : (
				<>
					<div className="flex items-center gap-2 text-sm" role="status">
						<StatusDot status={share.phase === "live" ? "live" : "warn"} label={t(`share.invite.phase.${share.phase}`)} />
						<span className="font-medium text-fg">{t(`share.invite.phase.${share.phase}`)}</span>
						{share.error && share.phase !== "live" && <span className="truncate text-fg-muted">— {share.error}</span>}
					</div>
					<CopyField label={t("share.invite.control")} description={t("share.invite.controlHint")} value={share.controlLink} />
					<CopyField label={t("share.invite.view")} description={t("share.invite.viewHint")} value={share.viewLink} />
					<div>
						<h3 className="mb-1.5 text-md font-medium text-fg">{t("share.invite.people", { count: guests.length })}</h3>
						{guests.length === 0 ? (
							<p className="text-sm text-fg-muted">{t("share.invite.nobody")}</p>
						) : (
							<ul className="flex flex-col gap-1">
								{guests.map((guest, index) => (
									<li key={`${guest.name}-${index}`} className="flex h-9 items-center gap-2.5 rounded-md px-1">
										<span
											className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-agent-muted text-xs font-semibold uppercase text-agent"
											aria-hidden
										>
											{guest.name.slice(0, 1) || "?"}
										</span>
										<span className="min-w-0 flex-1 truncate text-md text-fg">{guest.name}</span>
										<Chip tone={guest.readOnly ? "neutral" : "blue"}>{guest.readOnly ? t("share.invite.viewer") : t("share.invite.editor")}</Chip>
									</li>
								))}
							</ul>
						)}
					</div>
					<div className="flex justify-end">
						<Button variant="danger-ghost" loading={busy} onClick={() => void stop()}>
							{t("share.invite.stop")}
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
