/**
 * Opens the terminal sheet by itself whenever omp shows one of its own full-screen screens that
 * visual-omp does not draw (settings, pickers, login…), and closes it again when that screen goes
 * away — but only if it was opened this way.
 *
 * Two signals: omp's overlay count (full-screen menus), and the keyboard focus leaving omp's main
 * editor for a known dialog that replaces the editor in place (session tree, sign-in, goal prompt…).
 */
import { openOverlay, screenSurface } from "@shared/tsp/view-state";
import { useEffect, useRef } from "react";
import { useSessionView } from "../../shell/hooks";
import { controllerFor, useApp } from "../../state/app";
import { isNativeOverlay, screenName } from "./overlays";
import { autoOpened } from "./TerminalSheet";
import { useTsp } from "../tsp/useTsp";

/** Let omp finish painting before reading the screen. */
const SETTLE_MS = 300;

function TabWatch({ tabId }: { tabId: string }) {
	const view = useSessionView(controllerFor(tabId));
	/** Component kind that holds focus when omp sits at its main editor (names are minified per build). */
	const editorKind = useRef<string | null>(null);
	const live = view?.mode === "live" && !view.readOnly;
	const tui = live ? (view?.host?.tui ?? null) : null;
	const hostId = view?.host?.hostId ?? null;
	const tsp = view?.host?.transport === "tsp";
	const { snapshot } = useTsp(tsp ? view?.host?.hostId ?? null : null);
	const surfaces = snapshot?.lifecycle === "live" && snapshot.generation === view?.host?.generation
		? snapshot.surfaces.filter(surface => surface.documentGeneration === snapshot.generation) : [];
	const semanticScreen = !!(openOverlay(surfaces) || screenSurface(surfaces));
	const asking = Boolean(view?.guest?.uiRequest);
	const overlays = tui?.overlays ?? 0;
	const focused = tui?.focused ?? null;

	if (tui && overlays === 0 && !asking && !view?.working && focused && editorKind.current === null) {
		editorKind.current = focused;
	}
	const replaced = overlays === 0 && !asking && focused !== null && editorKind.current !== null && focused !== editorKind.current;
	const needsSheet = hostId !== null && !asking && (overlays > 0 || replaced);
	const screenKey = `${overlays}|${focused ?? ""}|${tui?.overlayKinds.join(",") ?? ""}`;

	useEffect(() => {
		if (tsp) {
			if (!live || !semanticScreen) {
				if (autoOpened.tabId === tabId) {
					autoOpened.tabId = null;
					if (useApp.getState().terminalTabId === tabId) useApp.getState().closeTerminal();
				}
			} else if (!useApp.getState().terminalTabId) {
				autoOpened.tabId = tabId;
				useApp.getState().openTerminal(tabId);
			}
			return;
		}
		if (!needsSheet || !hostId) {
			if (autoOpened.tabId === tabId) {
				autoOpened.tabId = null;
				if (useApp.getState().terminalTabId === tabId) useApp.getState().closeTerminal();
			}
			return;
		}
		if (useApp.getState().terminalTabId) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void window.vomp
				.invoke("host:screen", hostId)
				.then(lines => {
					if (cancelled || useApp.getState().terminalTabId || isNativeOverlay(lines)) return;
					// An in-place dialog only counts when we recognise it; focus moves for other reasons too.
					if (overlays === 0 && screenName(lines) === null) return;
					autoOpened.tabId = tabId;
					useApp.getState().openTerminal(tabId);
				})
				.catch(() => undefined);
		}, SETTLE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [needsSheet, hostId, tabId, screenKey, overlays, tsp, semanticScreen, live]);

	return null;
}

/** Watches the chats on screen (both halves of a split). */
export function OverlayWatcher() {
	const primary = useApp(state => (state.view === "chat" ? state.activeTabId : null));
	const secondary = useApp(state => (state.view === "chat" ? state.splitTabId : null));
	return (
		<>
			{primary && <TabWatch key={primary} tabId={primary} />}
			{secondary && secondary !== primary && <TabWatch key={secondary} tabId={secondary} />}
		</>
	);
}
