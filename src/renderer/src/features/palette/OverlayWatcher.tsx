/**
 * Opens requested omp UI after its native content arrives. Unrequested output never
 * opens a sheet. Command-opened sheets close when their native content disappears.
 */
import { useEffect, useMemo, useRef } from "react";
import { useSessionView } from "../../shell/hooks";
import { controllerFor, useApp } from "../../state/app";
import { isNativeOverlay, screenName } from "./overlays";
import { autoOpened } from "./TerminalSheet";
import { useTsp } from "../../state/tsp/useTsp";
import { currentPresentationConsumers, currentTabPresentationVisible, subscribePresentationConsumers, usePresentationAvailability, usePresentationClaims, useTabPresentationVisible } from "../../state/tsp/presentation-claims";
import { screenActivity, useScreenActivity } from "../../state/tsp/screen-activity";
import { screenCandidateKey } from "./auto-screen";

function closeAutomaticSheet(tabId: string): void {
	if (autoOpened.tabId !== tabId) return;
	autoOpened.tabId = null;
	if (useApp.getState().terminalTabId === tabId) useApp.getState().closeTerminal();
}


function TabWatch({ tabId }: { tabId: string }) {
	const controller = controllerFor(tabId);
	const view = useSessionView(controller);
	const visible = useTabPresentationVisible(tabId);
	/** Component kind that holds focus when omp sits at its main editor (names are minified per build). */
	const editorKind = useRef<string | null>(null);
	const live = view?.mode === "live" && !view.readOnly;
	const tui = live ? (view?.host?.tui ?? null) : null;
	const hostId = view?.host?.hostId ?? null;
	const tsp = view?.host?.transport === "tsp";
	const { snapshot, store } = useTsp(tsp ? hostId : null);
	const claims = usePresentationClaims(hostId, snapshot?.epoch);
	const available = usePresentationAvailability(hostId, snapshot?.epoch);
	// Automatic sheet state must not feed back through a card's covered/presented flag.
	// Availability survives that cover; hidden layout ancestors and unmount still release it.
	const nativeConsumers = useMemo(() => currentPresentationConsumers(hostId, snapshot?.epoch), [claims, available, hostId, snapshot?.epoch]);
	const scope = tsp && snapshot?.lifecycle === "live" && snapshot.hostId === hostId && snapshot.generation === view?.host?.generation ? snapshot : null;
	const semanticKey = scope ? screenCandidateKey(scope, nativeConsumers) : null;
	const activityScope = scope ?? (!tsp && view?.host ? { hostId: view.host.hostId, generation: view.host.generation, epoch: null } : null);
	const driveVersion = useScreenActivity(activityScope, "drive");
	const requestVersion = useScreenActivity(activityScope, "request");
	const currentKey = useRef<() => string | null>(() => null);
	currentKey.current = () => {
		const current = controller?.getSnapshot();
		const latest = store.getSnapshot();
		const app = useApp.getState();
		if (!scope || !current || (current.mode !== "live" && !(current.mode === "starting" && (screenActivity.has(scope, "request") || autoOpened.tabId === tabId))) || current.readOnly || current.host?.hostId !== scope.hostId || current.host.generation !== scope.generation
			|| !latest || latest.lifecycle !== "live" || latest.closing || latest.hostId !== scope.hostId || latest.generation !== scope.generation || latest.epoch !== scope.epoch
			|| app.view !== "chat" || app.activeTabId !== tabId && app.splitTabId !== tabId || !currentTabPresentationVisible(tabId)) return null;
		return screenCandidateKey(latest, currentPresentationConsumers(scope.hostId, scope.epoch));
	};
	const asking = Boolean(view?.guest?.uiRequest || view?.guest && [...view.guest.activeTools.values()].some(tool => tool.toolName === "ask"));
	const overlays = tui?.overlays ?? 0;
	const focused = tui?.focused ?? null;

	if (tui && overlays === 0 && !asking && !view?.working && focused && editorKind.current === null) {
		editorKind.current = focused;
	}
	const replaced = overlays === 0 && !asking && focused !== null && editorKind.current !== null && focused !== editorKind.current;
	const needsSheet = hostId !== null && !asking && (overlays > 0 || replaced);
	const screenKey = `${overlays}|${focused ?? ""}|${tui?.overlayKinds.join(",") ?? ""}`;

	useEffect(() => {
		if (!tsp) return;
		const observe = () => {
			const key = currentKey.current();
			if (key === null) closeAutomaticSheet(tabId);
		};
		const off = [store.subscribe(observe), ...(controller ? [controller.subscribe(observe)] : []), screenActivity.subscribe(observe), subscribePresentationConsumers(observe), useApp.subscribe(observe)];
		observe();
		return () => { for (const stop of off) stop(); };
	}, [tsp, store, controller, hostId, view?.host?.generation, snapshot?.epoch, tabId]);

	useEffect(() => {
		const onScreen = currentTabPresentationVisible(tabId);
		if (tsp) {
			let cancelled = false;
			const attempt = () => {
				const latest = store.getSnapshot();
				// Opening waits for this exact native frame's layout claims, including queued handoffs.
				if (cancelled || !scope || !latest || latest.revision !== scope.revision || latest.generation !== scope.generation || latest.epoch !== scope.epoch) return;
				const key = currentKey.current();
				if (key === null) {
					if ((live || view?.mode === "starting") && onScreen && currentTabPresentationVisible(tabId)) screenActivity.consumeRequests(scope, scope.revision);
					closeAutomaticSheet(tabId); return;
				}
				if (key !== semanticKey || screenActivity.has(scope, "drive")) return;
				const explicit = screenActivity.allowsRequest(scope, scope.revision, key);
				screenActivity.consumeRequests(scope, scope.revision);
				if (!explicit || useApp.getState().terminalTabId) return;
				autoOpened.tabId = tabId;
				useApp.getState().openTerminal(tabId);
			};
			attempt();
			return () => { cancelled = true; };
		}
		if (!needsSheet || !hostId || !onScreen) {
			if (autoOpened.tabId === tabId) {
				autoOpened.tabId = null;
				if (useApp.getState().terminalTabId === tabId) useApp.getState().closeTerminal();
			}
			return;
		}
		if (!activityScope || !screenActivity.has(activityScope, "request") || screenActivity.has(activityScope, "drive")) return;
		if (useApp.getState().terminalTabId) return;
		let cancelled = false;
		void window.vomp
			.invoke("host:screen", hostId)
			.then(lines => {
				if (cancelled || !currentTabPresentationVisible(tabId) || useApp.getState().terminalTabId || !screenActivity.has(activityScope, "request") || screenActivity.has(activityScope, "drive") || isNativeOverlay(lines)) return;
				// An in-place dialog only counts when we recognise it; focus moves for other reasons too.
				if (overlays === 0 && screenName(lines) === null) return;
				autoOpened.tabId = tabId;
				useApp.getState().openTerminal(tabId);
			})
			.catch(() => undefined);
		return () => { cancelled = true; };
	}, [needsSheet, hostId, tabId, screenKey, overlays, tsp, semanticKey, live, visible, driveVersion, requestVersion, snapshot?.revision]);

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
