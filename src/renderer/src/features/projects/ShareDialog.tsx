/**
 * Share dialog (DESIGN §4.20): encrypted links, exports, machine transfers and live invites.
 */
import type { ShareLinkResult } from "@shared/contracts/share";
import type { Participant } from "@oh-my-pi/pi-wire";
import { Broadcast, Check, Copy, Desktop, FileArrowDown, FileArrowUp, LinkSimple, Users, WarningCircle } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { APP_GUEST_NAME } from "../../collab/lib/client";
import type { SheetProps } from "@/registry/slots";
import { useSessionView } from "@/shell/hooks";
import { controllerFor, focusedTabId, useApp } from "@/state/app";
import { Button, Chip, Dialog, DialogContent, IconButton, Input, PresenceSwap, Segmented, StatusDot, Switch, spring, toast } from "@/ui";
import { errorText } from "./actions";
import { type ShareFileAction, useShares } from "./share-store";

export type ShareTab = "link" | "file" | "move" | "invite";

export interface ShareProps {
	tabId?: string | null;
	tab?: ShareTab;
}

const SHARE_TABS: readonly ShareTab[] = ["link", "file", "move", "invite"];

export function ShareDialog({ props, close }: SheetProps<ShareProps | undefined>): ReactNode {
	const { t } = useTranslation("projects");
	const tabId = useApp(state => props?.tabId ?? focusedTabId(state));
	const controller = controllerFor(tabId);
	const view = useSessionView(controller);
	const [tab, setTab] = useState<ShareTab>(props?.tab ?? "link");
	const sessionFile = controller?.sessionFile ?? null;
	// Panels slide toward the tab that was picked, in the order the tabs are shown.
	const index = SHARE_TABS.indexOf(tab);
	const [travel, setTravel] = useState<{ index: number; direction: 1 | -1 }>({ index, direction: 1 });
	if (travel.index !== index) setTravel({ index, direction: index > travel.index ? 1 : -1 });

	return (
		<Dialog open onOpenChange={open => !open && close()}>
			<DialogContent size="md" className="w-130" title={t("share.title")}>
				<Segmented<ShareTab>
					aria-label={t("share.kind")}
					className="mb-4"
					value={tab}
					onValueChange={setTab}
					options={[
						{ value: "link", label: t("share.tabs.link"), icon: <LinkSimple /> },
						{ value: "file", label: t("share.tabs.file"), icon: <FileArrowDown /> },
						{ value: "move", label: t("share.tabs.move"), icon: <Desktop /> },
						{ value: "invite", label: t("share.tabs.invite"), icon: <Users /> },
					]}
				/>
				<PresenceSwap swapKey={tab === "move" ? tab : controller ? `${tab}:${sessionFile}` : "none"} variant="slide" direction={travel.direction}>
					{tab === "move" ? (
						<MovePanel sessionFile={sessionFile} close={close} />
					) : !controller ? (
						<p className="text-md text-fg-muted">{t("share.noChat")}</p>
					) : tab === "link" ? (
						<LinkPanel sessionFile={sessionFile} />
					) : tab === "file" ? (
						<FilePanel sessionFile={sessionFile} />
					) : (
						<InvitePanel hostId={view?.host?.phase === "live" ? view.host.hostId : null} participants={view?.guest?.state?.participants ?? []} />
					)}
				</PresenceSwap>
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
	return <p className="rounded-md bg-inset px-3 py-2 text-sm text-fg-muted">{t("share.needsMessage")}</p>;
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
						<Button variant="primary" icon={<LinkSimple />} loading={busy} onClick={() => void create()}>
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
	const fileBusy = useShares(state => state.fileAction?.phase === "busy");
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
				<>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<span className="text-sm text-fg-faint">{t("share.file.note")}</span>
						<Button variant="primary" icon={<FileArrowDown />} loading={busy} disabled={fileBusy} onClick={() => void exportFile()}>
							{t("share.file.export")}
						</Button>
					</div>
					<section className="flex flex-col gap-3 border-t border-border pt-4">
						<h3 className="font-medium text-fg">{t("share.anonymize.title")}</h3>
						<p className="text-sm text-fg-muted">{t("share.anonymize.explainer")}</p>
						<p className="text-sm text-fg-muted">{t("share.anonymize.review")}</p>
						<FileAction kind="anonymize" sessionFile={sessionFile} disabled={busy} />
					</section>
				</>
			)}
		</div>
	);
}

function MovePanel({ sessionFile, close }: { sessionFile: string | null; close: () => void }): ReactNode {
	const { t } = useTranslation("projects");
	return (
		<div className="flex flex-col gap-4">
			<section className="flex flex-col gap-3">
				<h3 className="font-medium text-fg">{t("share.pack.title")}</h3>
				<p className="text-sm text-fg-muted">{t("share.pack.explainer")}</p>
				<p className="text-sm text-fg-muted">{t("share.pack.privacy")}</p>
				{sessionFile ? <FileAction kind="pack" sessionFile={sessionFile} /> : <NeedsMessage />}
			</section>
			<section className="flex flex-col gap-3 border-t border-border pt-4">
				<h3 className="font-medium text-fg">{t("share.unpack.title")}</h3>
				<p className="text-sm text-fg-muted">{t("share.unpack.explainer")}</p>
				<p className="text-sm text-fg-muted">{t("share.unpack.copies")}</p>
				<FileAction kind="unpack" close={close} />
			</section>
		</div>
	);
}

/** Native choosers and CLI work continue across tab switches; only the originating scope shows the result. */
function FileAction({ kind, sessionFile = null, close, disabled = false }: {
	kind: ShareFileAction;
	sessionFile?: string | null;
	close?: () => void;
	disabled?: boolean;
}): ReactNode {
	const { t } = useTranslation("projects");
	const fileAction = useShares(state => state.fileAction);
	const state = fileAction?.kind === kind && fileAction.sessionFile === sessionFile ? fileAction : null;
	const busy = fileAction?.phase === "busy";
	const [opening, setOpening] = useState(false);
	const open = async (file: string) => {
		setOpening(true);
		try {
			const summary = await window.vomp.invoke("sessions:summary", file);
			if (!summary) throw new Error(t("share.unpack.missing"));
			await useApp.getState().refreshProjects(false);
			useApp.getState().openSession(summary);
			close?.();
		} catch (error) {
			toast({ tone: "err", message: t("share.unpack.openFailed"), description: errorText(error) });
		} finally {
			setOpening(false);
		}
	};
	return (
		<div className="flex flex-col gap-3">
			{state?.phase === "error" && (
				<div role="alert" className="flex items-start gap-2 text-sm text-err">
					<WarningCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
					<div className="min-w-0">
						<p className="font-medium">{t(`share.${kind}.failed`)}</p>
						<p className="whitespace-pre-wrap break-words">{state.error}</p>
					</div>
				</div>
			)}
			{state?.phase === "cancelled" && <p role="status" className="text-sm text-fg-muted">{t("share.operation.cancelled")}</p>}
			{state?.phase === "done" && (
				<div className="selectable flex flex-col gap-2">
					<p role="status" className="flex items-center gap-2 text-sm font-medium">
						<Check className="size-4 text-ok" aria-hidden />{t(`share.${kind}.saved`)}
					</p>
					<p className="break-all font-mono text-xs text-fg-muted">{state.result.path}</p>
					{state.result.report && (
						<details className="text-sm text-fg-muted">
							<summary className="cursor-pointer">{t("share.operation.report")}</summary>
							<p className="mt-2 whitespace-pre-wrap break-words">{state.result.report}</p>
						</details>
					)}
					<div className="flex justify-end">
						<Button size="sm" loading={opening} onClick={() => kind === "unpack"
							? void open(state.result.path)
							: void window.vomp.invoke("app:showItem", state.result.path)}>
							{kind === "unpack" ? t("share.unpack.open") : t("share.file.reveal")}
						</Button>
					</div>
				</div>
			)}
			<div className="flex justify-end">
				<Button
					variant={kind === "unpack" ? "secondary" : "primary"}
					icon={kind === "unpack" ? <FileArrowUp /> : <FileArrowDown />}
					loading={state?.phase === "busy"}
					disabled={disabled || busy || opening}
					onClick={() => void useShares.getState().runFileAction(kind, sessionFile)}
				>
					{state?.phase === "busy" ? t(`share.${kind}.busy`) : t(`share.${kind}.action`)}
				</Button>
			</div>
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
			<PresenceSwap swapKey={on ? "on" : "off"} variant="rise" className="flex flex-col gap-4">
			{!on ? (
				<>
					<div className="flex items-center gap-2 rounded-md bg-inset px-3 py-2 text-sm text-fg-muted">
						<StatusDot status="idle" label={t("share.invite.off")} />
						<span className="flex-1">
							{share?.endedReason === "room-closed" ? t("share.invite.endedRestart") : share?.error ? share.error : t("share.invite.off")}
						</span>
					</div>
					<p className="text-sm text-fg-faint">{t("share.invite.privacy")}</p>
					<div className="flex justify-end">
						<Button variant="primary" icon={<Broadcast />} loading={busy} onClick={() => void start()}>
							{t("share.invite.start")}
						</Button>
					</div>
				</>
			) : (
				<>
					<div className="flex items-center gap-2 text-sm" role="status">
						<StatusDot status={share.phase === "live" ? "live" : "warn"} label={t(`share.invite.phase.${share.phase}`)} />
						<span className="font-medium text-fg">{t(`share.invite.phase.${share.phase}`)}</span>
						{share.error && share.phase !== "live" && <span className="truncate text-fg-muted">({share.error})</span>}
					</div>
					<CopyField label={t("share.invite.control")} description={t("share.invite.controlHint")} value={share.controlLink} />
					<CopyField label={t("share.invite.view")} description={t("share.invite.viewHint")} value={share.viewLink} />
					<div>
						<h3 className="mb-2 text-md font-medium text-fg">{t("share.invite.people", { count: guests.length })}</h3>
						{guests.length === 0 ? (
							<p className="text-sm text-fg-muted">{t("share.invite.nobody")}</p>
						) : (
							<ul className="relative flex flex-col gap-1">
								<AnimatePresence initial={false} mode="popLayout">
								{guests.map((guest, index) => (
									<motion.li
										key={`${guest.name}-${index}`}
										layout="position"
										initial={{ opacity: 0, y: -4 }}
										animate={{ opacity: 1, y: 0 }}
										exit={{ opacity: 0 }}
										transition={spring.snappy}
										className="flex h-9 items-center gap-2.5 rounded-md px-1"
									>
										<span
											className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-inset text-xs font-semibold text-fg-muted"
											aria-hidden
										>
											{guest.name.slice(0, 1).toUpperCase() || "?"}
										</span>
										<span className="min-w-0 flex-1 truncate text-md text-fg">{guest.name}</span>
										<Chip tone={guest.readOnly ? "neutral" : "accent"}>{guest.readOnly ? t("share.invite.viewer") : t("share.invite.editor")}</Chip>
									</motion.li>
								))}
								</AnimatePresence>
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
			</PresenceSwap>
		</div>
	);
}
