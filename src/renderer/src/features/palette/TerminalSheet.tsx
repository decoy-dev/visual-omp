/**
 * omp screen sheet (DESIGN §4.11): classic hosts mirror the hidden TUI through xterm.js.
 * TSP hosts draw omp's semantic overlays and unclaimed output. Only the classic mirror
 * resizes the hidden terminal and restores its previous size on close.
 */
import { openOverlay, screenSurface } from "@shared/tsp/view-state";
import { hookQuestions } from "@shared/tsp/question-match";
import { ArrowCounterClockwise, ArrowsIn, ArrowsOut, TerminalWindow, Warning } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { isResumeDeclined } from "../../registry/guards";
import { LoadFailed, type LoadFailureProps, lazyView } from "../../registry/lazy";
import { useSessionView } from "../../shell/hooks";
import { controllerFor, useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { Button, cn, Dialog, DialogContent, EmptyState, Expand, IconButton, Sheet, SheetContent, Spinner } from "../../ui";
import { type ScreenKey, screenName } from "./overlays";
import { useTsp } from "../../state/tsp/useTsp";
import { plain } from "../../state/tsp/labels";
import { usePresentationAvailability, usePresentationClaims } from "../../state/tsp/presentation-claims";

function insideAppPopup(target: EventTarget | null): boolean {
	return target instanceof Element && !!target.closest('.tsp-select-popup, [role="combobox"][data-state="open"]');
}

/** Tab whose sheet the overlay watcher opened (so it closes again when omp's screen goes away). */
export const autoOpened: { tabId: string | null } = { tabId: null };

/** Close the open sheet the way its close button does (asks first when an omp menu is open). */
export const terminalSheet: { requestClose: (() => void) | null } = { requestClose: null };

/** If xterm.js or the omp screen does not load, the sheet's body shows the failure state with Try again. */
function TerminalLoadFailed({ retry }: LoadFailureProps) {
	return <div className="flex h-full items-center justify-center"><LoadFailed retry={retry} /></div>;
}

/** xterm.js loads with the first sheet opened (or in idle time); the sheet's inset surface shows until then. */
const Mirror = lazyView(
	() => import("./TerminalMirror").then(m => m.Mirror),
	() => <div className="h-full" />,
	TerminalLoadFailed,
);
const OmpScreen = lazyView(
	() => import("../tsp/OmpScreenSheet").then(m => m.OmpScreenSheet),
	() => <div role="status" className="h-full" />,
	TerminalLoadFailed,
);

/** Recognisable name of the omp screen on show, refreshed as omp repaints. */
function useScreenName(hostId: string | null, tuiKey: string): ScreenKey | null {
	const [name, setName] = useState<ScreenKey | null>(null);
	useEffect(() => {
		if (!hostId) return;
		let live = true;
		let timer: number | undefined;
		const refresh = () => {
			clearTimeout(timer);
			timer = window.setTimeout(() => {
				void window.vomp
					.invoke("host:screen", hostId)
					.then(lines => {
						if (live) setName(screenName(lines));
					})
					.catch(() => undefined);
			}, 250);
		};
		refresh();
		const off = window.vomp.on("host:data", ({ hostId: id }) => {
			if (id === hostId) refresh();
		});
		return () => {
			live = false;
			clearTimeout(timer);
			off();
		};
	}, [hostId, tuiKey]);
	return name;
}

export function TerminalSheet({ tabId, controller }: { tabId: string; controller: SessionController }) {
	const { t } = useTranslation("palette");
	const view = useSessionView(controller);
	const [expanded, setExpanded] = useState(false);
	const [confirmLeave, setConfirmLeave] = useState(false);
	const [screenError, setScreenError] = useState<string | null>(null);
	const [restarting, setRestarting] = useState(false);
	const restartTsp = async () => {
		setScreenError(null);
		setRestarting(true);
		try { await controller.restart(); }
		catch (error) { if (!isResumeDeclined(error)) setScreenError(error instanceof Error ? error.message : String(error)); }
		finally { setRestarting(false); }
	};
	const host = view?.host ?? null;
	const hostId = host && host.phase !== "exited" ? host.hostId : null;
	const tsp = host?.transport === "tsp";
	const { snapshot, failed } = useTsp(tsp ? host?.hostId ?? null : null);
	const tspSurfaces = snapshot?.lifecycle === "live" && snapshot.generation === host?.generation
		? snapshot.surfaces.filter(surface => surface.documentGeneration === host.generation) : [];
	const presentationClaims = usePresentationClaims(hostId, snapshot?.epoch);
	const availableConsumers = usePresentationAvailability(hostId, snapshot?.epoch);
	const overlay = openOverlay(tspSurfaces, false, presentationClaims);
	const screenSurfaceOpen = screenSurface(tspSurfaces);
	const overlayHead = overlay?.node.k === "overlay" ? plain(overlay.node.p?.head) : overlay?.node.p?.title;
	const readOnly = view?.readOnly ?? false;
	const tui = host?.tui ?? null;
	const screen = useScreenName(tsp ? null : hostId, `${tui?.overlays ?? 0}|${tui?.focused ?? ""}|${tui?.overlayKinds.join(",") ?? ""}`);
	/** The hidden terminal's size before the sheet resized it. */
	const previousSize = useRef<{ hostId: string; cols: number; rows: number } | null>(null);
	const inspectorContent = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (readOnly) return;
		// Declining the large-chat warning leaves omp stopped, so this sheet would only show "Starting omp…" forever.
		void controller.ensureLive().catch((error: unknown) => {
			if (isResumeDeclined(error) && useApp.getState().terminalTabId === tabId) useApp.getState().closeTerminal();
		});
	}, [controller, readOnly, tabId]);

	if (tsp) previousSize.current = null;
	else if (host && host.phase !== "exited" && previousSize.current?.hostId !== host.hostId) {
		previousSize.current = { hostId: host.hostId, cols: host.cols, rows: host.rows };
	}
	useEffect(
		() => () => {
			const size = previousSize.current;
			if (size) void window.vomp.invoke("host:resize", size.hostId, size.cols, size.rows).catch(() => undefined);
			// Forget the auto-open only when the sheet closed: a StrictMode remount runs this cleanup with the sheet still open.
			queueMicrotask(() => {
				if (autoOpened.tabId === tabId && useApp.getState().terminalTabId !== tabId) autoOpened.tabId = null;
			});
		},
		[tabId],
	);

	const close = () => useApp.getState().closeTerminal();
	const overlaysOpen = () => (controller.getSnapshot().host?.tui?.overlays ?? 0) > 0;
	const requestClose = () => {
		if (!tsp && overlaysOpen() && !readOnly && view?.mode === "live") setConfirmLeave(true);
		else close();
	};
	const escapeTsp = (target: EventTarget | null) => {
		const rawFallback = target instanceof Element && !!target.closest('[data-tsp-kind="rows"], [data-tsp-kind="ansi"]');
		const hooks = hookQuestions(tspSurfaces, host?.generation ?? 0);
		// A covering sheet may reveal the generic hook, but Escape returns to its available native card.
		if (hooks.some(hook => availableConsumers.get(hook.surfaceId)?.has(hook.nodeId))) { requestClose(); return; }
		const localHook = hooks.length === 1 && snapshot?.questionMatches?.some(match =>
			match.surfaceId === hooks[0]!.surfaceId && match.nodeId === hooks[0]!.nodeId && match.status === "unmatched");
		if ((overlay || screenSurfaceOpen || rawFallback || (snapshot?.composer?.queued.length ?? 0) > 0) && !readOnly && !snapshot?.closing && (!hooks.length || localHook) && typeof snapshot?.epoch === "number") {
			void window.vomp.invoke("host:keys", host!.hostId, "escape", snapshot.generation, snapshot.epoch).catch(error => {
				if ((snapshot.composer?.queued.length ?? 0) > 0 || snapshot.editorRestore) setScreenError(error instanceof Error ? error.message : String(error));
				else requestClose();
			});
		} else requestClose();
	};
	terminalSheet.requestClose = requestClose;
	useEffect(
		() => () => {
			terminalSheet.requestClose = null;
		},
		[],
	);
	const leave = async () => {
		setConfirmLeave(false);
		if (controller.getSnapshot().host?.transport !== "tsp") await controller.keys("escape");
		close();
	};

	const title = tsp ? overlayHead ? t("tsp.titleWith", { screen: overlayHead }) : screenSurfaceOpen?.open.title ? t("tsp.titleWith", { screen: screenSurfaceOpen.open.title }) : t("tsp.title") : screen ? t("terminal.titleWith", { screen: t(`screens.${screen}`) }) : t("terminal.title");
	const mode = view?.mode ?? "starting";

	return (
		<Sheet
			open
			onOpenChange={open => {
				if (!open) requestClose();
			}}
		>
			<SheetContent
				side="bottom"
				className="omp-screen-sheet"
				height={expanded ? "calc(100vh - var(--titlebar-h) - 16px)" : "80vh"}
				title={
					<span className="flex items-center gap-2">
						<TerminalWindow aria-hidden className="size-4 text-fg-muted" />
						<span className="truncate text-md">{title}</span>
					</span>
				}
				description={tsp ? t("tsp.hint") : readOnly ? t("terminal.readOnly") : t("terminal.hint")}
				actions={
					<IconButton
						label={expanded ? t("terminal.shrink") : t("terminal.expand")}
						icon={expanded ? <ArrowsIn /> : <ArrowsOut />}
						onClick={() => setExpanded(value => !value)}
					/>
				}
				onKeyDownCapture={event => {
					if (!tsp || event.key !== "Escape" || event.defaultPrevented || insideAppPopup(event.target)) return;
					event.preventDefault();
					event.stopPropagation();
					escapeTsp(event.target);
				}}
				onEscapeKeyDown={event => {
					// Esc inside the mirror belongs to omp (the key handler decides); elsewhere it closes.
					if (tsp && (event.defaultPrevented || insideAppPopup(event.target))) return;
					event.preventDefault();
					if (tsp) {
						escapeTsp(event.target);
					} else if (!(event.target instanceof Element && event.target.closest(".xterm"))) requestClose();
				}}
				onOpenAutoFocus={event => {
					event.preventDefault();
					if (tsp) inspectorContent.current?.focus();
				}}
				onCloseAutoFocus={event => {
					if (!tsp) return;
					event.preventDefault();
					useComposerDrafts.getState().focus(tabId);
				}}
				bodyClassName="flex flex-col gap-2 overflow-hidden bg-inset p-3"
			>
				<Expand open={mode === "reconnecting"}>
					<div role="status" className="flex h-8 shrink-0 items-center gap-2 rounded-md bg-warn-bg px-3 text-sm text-warn">
						<Spinner size={12} tone="current" />
						{t("terminal.reconnecting")}
					</div>
				</Expand>
				<Expand open={screenError !== null}>
					<p role="alert" className="rounded-md bg-err-bg px-3 py-2 text-sm text-err">{screenError}</p>
				</Expand>
				<Expand open={tsp && snapshot?.lifecycle === "failed"}>
					<div role="alert" className="flex flex-wrap items-center gap-2 rounded-md bg-err-bg px-3 py-2 text-sm text-err">
						<Warning aria-hidden className="size-4" />
						<span className="flex-1">{snapshot?.failure}</span>
						<Button size="sm" variant="secondary" disabled={restarting || readOnly} onClick={() => void restartTsp()}>{t("terminal.restart")}</Button>
					</div>
				</Expand>
				<Expand open={mode === "exited" && (!tsp || snapshot?.lifecycle !== "failed")}>
					<div role="alert" className="flex h-9 shrink-0 items-center gap-2 rounded-md bg-err-bg px-3 text-sm text-err">
						<Warning aria-hidden className="size-4" />
						<span className="flex-1">{t("terminal.disconnected")}</span>
						<Button size="sm" variant="secondary" icon={<ArrowCounterClockwise />} disabled={restarting || readOnly} onClick={() => tsp ? void restartTsp() : void controller.restart()}>
							{t("terminal.restart")}
						</Button>
					</div>
				</Expand>
				<div className={cn("min-h-0 flex-1 transition-opacity duration-(--dur-slow)", mode === "exited" && "opacity-60")}>
					{tsp && host ? (
						<OmpScreen key={`${host.hostId}:${host.generation}:${snapshot?.epoch ?? "waiting"}`} contentRef={inspectorContent} hostId={host.hostId} generation={host.generation} snapshot={snapshot} failed={failed} readOnly={readOnly} />
					) : hostId && host ? (
						<Mirror
							hostId={hostId}
							generation={host.generation}
							readOnly={readOnly || mode !== "live"}
							onIdleEscape={requestClose}
							overlaysOpen={overlaysOpen}
						/>
					) : readOnly ? (
						<EmptyState icon={<TerminalWindow />} title={t("terminal.readOnly")} />
					) : mode !== "exited" ? (
						<div className="flex h-full items-center justify-center gap-2 text-md text-fg-muted">
							<Spinner size={14} />
							{t("terminal.starting")}
						</div>
					) : null}
				</div>
			</SheetContent>
			<Dialog open={confirmLeave && !tsp} onOpenChange={setConfirmLeave}>
				<DialogContent
					size="sm"
					title={t("terminal.leaveTitle")}
					description={t("terminal.leaveBody")}
					footer={
						<>
							<Button variant="secondary" onClick={() => setConfirmLeave(false)}>
								{t("terminal.stay")}
							</Button>
							<Button variant="primary" onClick={() => void leave()}>
								{t("terminal.leave")}
							</Button>
						</>
					}
				/>
			</Dialog>
		</Sheet>
	);
}

/** Mounted once at the app root; follows `useApp().terminalTabId`. */
export function TerminalSheetHost() {
	const tabId = useApp(state => state.terminalTabId);
	const controller = controllerFor(tabId);
	if (!tabId || !controller) return null;
	return <TerminalSheet key={tabId} tabId={tabId} controller={controller} />;
}
