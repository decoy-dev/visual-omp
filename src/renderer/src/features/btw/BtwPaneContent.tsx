import { ArrowUp, ChatCircle, Copy, Plus, Stop } from "@phosphor-icons/react";
import { type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { BtwState, BtwStatus, BtwTopic, BtwTopicRef } from "@shared/contracts/btw";
import type { HostState } from "@shared/ipc";
import { tspHost, type TspHostSource } from "../../state/tsp/hosts";
import { btwTopicKey, projectBtw, sameBtwTopic, type BtwProjection } from "@shared/tsp/btw";
import { TSP_ACTIONS } from "@shared/tsp/roles";
import { errorText } from "@shared/errors";
import { PresentationVisibility, presentationClaims, usePresentationClaim } from "../../state/tsp/presentation-claims";
import { Markdown, StreamingMarkdown } from "../../transcript/Markdown";
import { Button, EmptyState, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, Spinner, Textarea, toast } from "../../ui";
import { PaneToolbar, usePaneVisible } from "../panes/common";
import { controllerFor, dockKey, useApp } from "../../state/app";
import { BtwPaneLoading, BtwPresentation, useBtwPresentation } from "./BtwPane";
import type { SessionController } from "../../state/session";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { i18n } from "../../i18n";
import { AnimatePresence } from "motion/react";
import { duration, FadeIn, Rise, useMotionReduced } from "../../ui/motion";
import { useTsp } from "../../state/tsp/useTsp";
import { useSessionView } from "../../shell/hooks";
import type { PaneProps } from "../../registry/slots";
import { flushSync } from "react-dom";

interface PanelPutAway {
	result: Promise<void>;
	active: boolean;
	error: string | null;
	completion?: Promise<void>;
}
const panelPutAways = new WeakMap<SessionController, Map<string, PanelPutAway>>();
const panelPutAwayListeners = new Set<() => void>();
function subscribePanelPutAway(listener: () => void) {
	panelPutAwayListeners.add(listener);
	return () => { panelPutAwayListeners.delete(listener); };
}
function panelPutAwayKey(host: Pick<HostState, "hostId" | "generation" | "tspEpoch">, projection: BtwProjection): string {
	return JSON.stringify([host.hostId, host.generation, host.tspEpoch, projection.surfaceId, projection.nodeId]);
}

/** One native operation survives pane remounts; the renderer deadline never replays an outstanding close. */
export function putAwayBtwPanel(session: SessionController, host: HostState, projection: BtwProjection, store: TspHostSource): Promise<void> {
	let operations = panelPutAways.get(session);
	if (!operations) { operations = new Map(); panelPutAways.set(session, operations); }
	const key = panelPutAwayKey(host, projection);
	const previous = operations.get(key);
	if (previous?.active) return previous.result;
	if (host.tspEpoch === undefined) return Promise.reject(new Error("The chat changed before the side question could be put away."));
	const releasePresentation = presentationClaims.acquire({ hostId: host.hostId, epoch: host.tspEpoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId });
	const deadline = Promise.withResolvers<void>();
	const documentClosed = Promise.withResolvers<void>();
	let expired = false;
	let nativeSettled = false;
	let requestSettled = false;
	let latest = store.getSnapshot();
	const finished = () => !latest || latest.generation !== host.generation || latest.epoch !== host.tspEpoch
		|| projectBtw(latest.surfaces)?.nodeId !== projection.nodeId;
	const off = store.subscribe(() => {
		const next = store.getSnapshot();
		if (!next || next.hostId !== host.hostId || latest && next.revision <= latest.revision) return;
		latest = next;
		if (finished()) documentClosed.resolve();
	});
	const timer = setTimeout(() => {
		expired = true;
		deadline.reject(new Error("omp did not close the side-question history."));
	}, 8000);
	const result = Promise.withResolvers<void>();
	const operation: PanelPutAway = { result: result.promise, active: true, error: null };
	operations.set(key, operation);
	for (const listener of panelPutAwayListeners) listener();
	const native = (async () => {
		const state = await window.vomp.invoke("btw:list", host.hostId);
		if (expired) return;
		const current = session.getSnapshot().host;
		if (controllerFor(session.tabId) !== session || state.hostId !== host.hostId || state.generation !== host.generation || state.epoch !== host.tspEpoch
			|| current?.hostId !== host.hostId || current.generation !== host.generation || current.tspEpoch !== host.tspEpoch) throw new Error("The chat changed before the side question could be put away.");
		if (state.overlay) await window.vomp.invoke("btw:close", host.hostId, state.overlay.selectedTopic, { generation: host.generation, epoch: host.tspEpoch });
	})();
	const settleNative = () => {
		nativeSettled = true;
		if (requestSettled) {
			operation.active = false;
			for (const listener of panelPutAwayListeners) listener();
		}
	};
	void native.then(settleNative, settleNative);
	const completed = native.then(async () => { if (!expired && !finished()) await documentClosed.promise; });
	void Promise.race([completed, deadline.promise]).catch(error => {
		operation.error = errorText(error);
		for (const listener of panelPutAwayListeners) listener();
		throw error;
	}).finally(() => {
		requestSettled = true;
		if (nativeSettled) operation.active = false;
		clearTimeout(timer);
		off();
		documentClosed.resolve();
		releasePresentation();
		for (const listener of panelPutAwayListeners) listener();
	}).then(result.resolve, result.reject);
	return operation.result;
}

interface BtwOpening {
	error: string | null;
	dismissed: boolean;
	dismiss(): void;
	stop(): void;
}
const btwOpenings = new WeakMap<SessionController, BtwOpening>();

/** Keep a scoped listener after cancellation so a late native overlay is put away without a saved toast. */
export async function openBtwDrawer(session: SessionController, host: HostState, question: string): Promise<void> {
	const epoch = host.tspEpoch;
	if (epoch === undefined) throw new Error("Waiting for omp to open its semantic screen.");
	btwOpenings.get(session)?.stop();
	const ready = Promise.withResolvers<void>();
	const store = tspHost(host.hostId);
	let seen = false;
	let closing = false;
	let stopped = false;
	const notify = () => { for (const listener of panelPutAwayListeners) listener(); };
	const current = () => {
		const next = session.getSnapshot().host;
		return controllerFor(session.tabId) === session && next?.hostId === host.hostId && next.generation === host.generation && next.tspEpoch === host.tspEpoch;
	};
	const request: BtwOpening = {
		error: null, dismissed: false,
		dismiss() {
			request.dismissed = true;
			clearTimeout(timer);
			ready.resolve();
			useApp.setState(state => ({ btwDrawers: { ...state.btwDrawers, [session.tabId]: false } }));
			notify();
			requestAnimationFrame(() => { if (current() && dockKey(useApp.getState()) === session.tabId) useComposerDrafts.getState().focus(session.tabId); });
		},
		stop() {
			if (stopped) return;
			stopped = true;
			clearTimeout(timer); off(); offSession(); offApp(); ready.resolve();
			if (btwOpenings.get(session) === request) btwOpenings.delete(session);
			notify();
		},
	};
	const timer = setTimeout(() => {
		request.error = i18n.t("panes:btw.openingFailed");
		ready.resolve(); notify();
	}, 8000);
	const off = store.subscribe(() => {
		const next = store.getSnapshot();
		if (!next || next.generation !== host.generation || next.epoch !== host.tspEpoch || !current()) return;
		const projection = projectBtw(next.surfaces);
		if (!projection) { if (seen) request.stop(); return; }
		seen = true;
		clearTimeout(timer); ready.resolve();
		if (!request.dismissed) { request.error = null; notify(); }
		if (!request.dismissed || closing) return;
		closing = true;
		void putAwayBtwPanel(session, host, projection, store).then(() => request.stop(), error => {
			closing = false; request.dismissed = false; request.error = errorText(error);
			useApp.setState(state => ({ btwDrawers: { ...state.btwDrawers, [session.tabId]: true } }));
			notify();
		});
	});
	const offSession = session.subscribe(() => { if (!current()) request.stop(); });
	const offApp = useApp.subscribe(() => { if (!current()) request.stop(); });
	btwOpenings.set(session, request);
	flushSync(() => {
		useApp.setState(state => ({ btwDrawers: { ...state.btwDrawers, [session.tabId]: true } }));
		useApp.getState().returnToChat();
	});
	notify();
	const native = window.vomp.invoke("btw:ask", host.hostId, question, { generation: host.generation, epoch }).catch(error => {
		if (stopped) return;
		request.error = errorText(error);
		clearTimeout(timer); ready.resolve(); notify();
	});
	await Promise.race([ready.promise, native]);
}

/** All drawer dismissal gestures share one native close, completion toast and focus restoration. */
export function finishBtwDrawer(session: SessionController, host: HostState, projection: BtwProjection, store: TspHostSource): Promise<void> {
	if (projectBtw(store.getSnapshot()?.surfaces ?? [])?.nodeId !== projection.nodeId) return Promise.resolve();
	const result = putAwayBtwPanel(session, host, projection, store);
	const operation = panelPutAways.get(session)!.get(panelPutAwayKey(host, projection))!;
	if (operation.completion) return operation.completion;
	operation.completion = result.then(() => {
		const current = session.getSnapshot().host;
		if (controllerFor(session.tabId) !== session || current?.hostId !== host.hostId || current.generation !== host.generation
			|| current.tspEpoch !== host.tspEpoch) return;
		useApp.setState(state => ({ btwDrawers: { ...state.btwDrawers, [session.tabId]: false } }));
		if (projection.turns.length || projection.topics.length) toast({ tone: "ok", message: i18n.t("panes:btw.saved"), action: { label: i18n.t("panes:btw.viewHistory"), onClick: () => {
			if (controllerFor(session.tabId) === session) useApp.getState().showPane("btw", session.tabId);
		} } });
		requestAnimationFrame(() => {
			if (controllerFor(session.tabId) === session && dockKey(useApp.getState()) === session.tabId) useComposerDrafts.getState().focus(session.tabId);
		});
	});
	return operation.completion;
}

/** Chat-local layout and keyboard handling stay in the lazy BTW chunk. */
export function BottomDrawer({ open, children, onDismiss, label }: { open: boolean; children: ReactNode; onDismiss(): void; label: string }) {
	const reduced = useMotionReduced();
	return <AnimatePresence>{open && <div key="drawer" className="absolute inset-0 z-20 flex flex-col justify-end">
		<FadeIn animateOnMount data-btw-scrim aria-hidden="true" className="absolute inset-0 bg-backdrop/50" onClick={onDismiss}
			exit={{ opacity: 0, transition: { duration: duration.slow, ease: "easeIn" } }} />
		<Rise as="section" animateOnMount distance={reduced ? 0 : "100%"} data-btw-drawer role="dialog" aria-label={label}
			exit={{ opacity: 0, ...(reduced ? {} : { y: "100%" }), transition: { duration: duration.slow, ease: "easeIn" } }}
			className="relative mx-3 mb-3 flex h-[min(75%,42rem)] min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-panel text-fg shadow-overlay"
			onKeyDown={event => {
				if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
					event.preventDefault(); event.stopPropagation(); onDismiss();
				}
			}}>{children}</Rise>
	</div>}</AnimatePresence>;
}

export function BtwDrawerHost() {
	const { t } = useTranslation("panes");
	const content = useContext(BtwPresentation);
	const session = content ? controllerFor(content.tabId) : null;
	const view = useSessionView(session);
	const host = view?.host ?? null;
	useEffect(() => () => {
		if (content && !controllerFor(content.tabId)) useApp.setState(state => ({
			btwDrawers: Object.fromEntries(Object.entries(state.btwDrawers).filter(([id]) => id !== content.tabId)),
		}));
	}, [content?.tabId]);
	const { store } = useTsp(content?.hostId ?? null);
	const open = !!content?.presentation.available;
	const projection = content?.projection;
	const requested = useApp(app => !!content && !!app.btwDrawers[content.tabId]);
	const openingError = useSyncExternalStore(subscribePanelPutAway, () => session ? btwOpenings.get(session)?.error ?? null : null);
	const dismissed = useSyncExternalStore(subscribePanelPutAway, () => session ? btwOpenings.get(session)?.dismissed ?? false : false);
	const button = useRef<HTMLButtonElement>(null);
	useLayoutEffect(() => { if (open) button.current?.focus(); }, [open, projection?.nodeId]);
	const opening = useRef<{ scope: string; presented: boolean } | null>(null);
	const scope = host ? JSON.stringify([host.hostId, host.generation, host.tspEpoch]) : "";
	useLayoutEffect(() => {
		if (!requested) { opening.current = null; return; }
		if (content && opening.current && (opening.current.scope !== scope || opening.current.presented && !projection)) {
			opening.current = null;
			useApp.setState(state => ({ btwDrawers: { ...state.btwDrawers, [content.tabId]: false } }));
		} else opening.current = { scope, presented: opening.current?.presented === true || !!projection };
	}, [requested, scope, projection, content?.tabId]);
	const dismiss = () => {
		if (!session || !host) return;
		if (projection) void finishBtwDrawer(session, host, projection, store).catch(() => {});
		else btwOpenings.get(session)?.dismiss();
	};
	return <BottomDrawer open={open && !dismissed} onDismiss={dismiss} label={t("btw.question")}>
		<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
			<h2 className="text-md font-medium">{t("btw.question")}</h2>
			<Button ref={button} size="sm" variant="primary" onClick={dismiss}>{t("btw.done")}</Button>
		</div>
		{openingError && <p role="alert" className="shrink-0 px-4 py-3 text-sm text-err">{openingError}</p>}
		<BtwPresentation.Provider value={content}><BtwPaneHost /></BtwPresentation.Provider>
	</BottomDrawer>;
}

export function BtwHistoryHost({ session }: PaneProps) {
	const { t } = useTranslation("panes");
	const visible = usePaneVisible("btw");
	const { view, host, projection, target } = useBtwPresentation(session);
	if (!session || !host) return <EmptyState icon={<ChatCircle />} title={t("btw.noChatTitle")} body={t("btw.noChat")} />;
	return <BtwPresentation.Provider value={{ tabId: session.tabId, hostId: host.hostId, generation: host.generation, epoch: host.tspEpoch,
		readOnly: !!view?.readOnly || host.phase !== "live", projection, target, drawer: false,
		presentation: { active: false, available: visible } }}><BtwPaneHost /></BtwPresentation.Provider>;
}

export interface BtwPaneContentProps {
	state: BtwState | null;
	error: string | null;
	readOnly?: boolean;
	hostId: string;
	presentation?: { active: boolean; available: boolean };
	historyOnly?: boolean;
	drawer?: boolean;
	closing?: boolean;
}

/** Subscribe before the initial read; a late response cannot replace a newer frame or disk update. */
function useBtw(hostId: string | null, generation: number | undefined, epoch: number | undefined) {
	const [state, setState] = useState<BtwState | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!hostId) return;
		let active = true;
		setState(null);
		setError(null);
		const accept = (next: BtwState) => {
			if (!active || next.hostId !== hostId || next.generation !== generation || epoch !== undefined && next.epoch !== epoch) return;
			setState(previous => previous && previous.revision >= next.revision ? previous : next);
			setError(null);
		};
		const off = window.vomp.on("btw:changed", accept);
		void window.vomp.invoke("btw:list", hostId).then(accept).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
		return () => { active = false; off(); };
	}, [hostId, generation, epoch]);
	return { state: state?.hostId === hostId && state.generation === generation && (epoch === undefined || state.epoch === epoch) ? state : null, error };
}

/** Keep saved drafts mounted while a new document waits for its scoped history identity. */
export function BtwPaneHost() {
	const { t } = useTranslation("panes");
	const content = useContext(BtwPresentation);
	const { state, error } = useBtw(content?.hostId ?? null, content?.generation, content?.epoch);
	const session = content ? controllerFor(content.tabId) : null;
	const closeKey = content?.projection ? panelPutAwayKey({ hostId: content.hostId, generation: content.generation, tspEpoch: content.epoch }, content.projection) : null;
	const closeError = useSyncExternalStore(subscribePanelPutAway, () => session && closeKey ? panelPutAways.get(session)?.get(closeKey)?.error ?? null : null);
	const closing = useSyncExternalStore(subscribePanelPutAway, () => session && closeKey ? panelPutAways.get(session)?.get(closeKey)?.active ?? false : false);
	if (!content) return null;
	const { projection, target, hostId, readOnly, presentation } = content;
	const overlay = state?.overlay;
	const pending = projection?.supported && (!state || overlay?.nodeId !== projection.nodeId || overlay.surfaceId !== projection.surfaceId || overlay.epoch !== target?.epoch);
	return <>
		{overlay && !overlay.supported && <div className="border-b border-border p-3"><p className="mb-2 text-sm text-fg-muted">{t("btw.unsupported")}</p><Button size="sm" variant="secondary" onClick={() => useApp.getState().openTerminal(content.tabId)}>{t("btw.openScreen")}</Button></div>}
		{pending && <><BtwPaneLoading />{(closeError || error) && <p role="alert" className="shrink-0 px-4 pb-3 text-sm text-err">{closeError ?? error}</p>}</>}
		<div className={pending ? "hidden" : "flex min-h-0 flex-1 flex-col"}><PresentationVisibility visible={!pending && projection?.supported !== false}>
			<BtwPaneContent state={state} error={closeError ?? error} readOnly={readOnly} hostId={hostId} presentation={presentation} historyOnly={!content.drawer} drawer={content.drawer} closing={closing} />
		</PresentationVisibility></div>
	</>;
}

interface Composer { mode: "ask" | "followUp"; draft: string; topic: BtwTopicRef | null; title: string | null }
interface PaneContext {
	selection: BtwTopicRef | null;
	overlayKey: string | null;
	composers: Record<string, Composer>;
	activeComposer: string | null;
	busy: symbol | null;
	error: string | null;
	copied: boolean;
}
const emptyContext = (): PaneContext => ({ selection: null, overlayKey: null, composers: {}, activeComposer: null, busy: null, error: null, copied: false });

/** Contexts retain drafts at their original host, generation, epoch and topic. */
export function BtwPaneContent({ state, error: loadError, readOnly, hostId, presentation, historyOnly = false, drawer = false, closing }: BtwPaneContentProps) {
	const { t } = useTranslation("panes");
	const [contexts, setContexts] = useState<Record<string, PaneContext>>({});
	const operations = useRef(new Map<string, symbol>());
	const contextKey = JSON.stringify([hostId, state?.generation ?? null, state?.epoch ?? null]);
	let context = contexts[contextKey] ?? emptyContext();
	const overlay = state?.overlay;
	const overlayKey = overlay ? JSON.stringify([overlay.surfaceId, overlay.nodeId, overlay.selectedTopic && btwTopicKey(overlay.selectedTopic), overlay.followUp]) : null;
	if (!contexts[contextKey] || context.overlayKey !== overlayKey) {
		context = { ...context, overlayKey, selection: overlay?.selectedTopic ?? context.selection, activeComposer: overlay ? null : context.activeComposer };
		if (overlay?.followUp && overlay.selectedTopic) {
			const key = `followUp:${btwTopicKey(overlay.selectedTopic)}`;
			context = { ...context, activeComposer: key, composers: { ...context.composers, [key]: context.composers[key] ?? { mode: "followUp", draft: overlay.draft ?? "", topic: overlay.selectedTopic, title: state?.topics.find(topic => sameBtwTopic(topic, overlay.selectedTopic))?.title ?? null } } };
		}
		setContexts(previous => ({ ...previous, [contextKey]: context }));
	}
	const updateContext = (key: string, update: (current: PaneContext) => PaneContext) => setContexts(previous => ({ ...previous, [key]: update(previous[key] ?? emptyContext()) }));
	const update = (update: (current: PaneContext) => PaneContext) => updateContext(contextKey, update);
	const input = useRef<HTMLTextAreaElement>(null);
	const body = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const topics = drawer && overlay ? (state?.topics ?? []).filter(topic => overlay.topics.some(ref => sameBtwTopic(ref, topic))) : state?.topics ?? [];
	const topic = topics.find(topic => sameBtwTopic(topic, context.selection)) ?? topics.find(topic => sameBtwTopic(topic, overlay?.selectedTopic)) ?? topics[0];
	const topicRef = topic ? { id: topic.id, ...(topic.scope !== undefined ? { scope: topic.scope } : {}) } : null;
	const topicKey = topic ? btwTopicKey(topic) : "";
	const latest = topic?.turns.at(-1);
	const nativeTopic = !!topic && !!overlay?.topics.some(ref => sameBtwTopic(ref, topic));
	const displayingEmptyOverlay = !!overlay && overlay.selectedTopic === null && overlay.topics.length === 0 && topics.length === 0 && !topic;
	const displayingOverlay = displayingEmptyOverlay || nativeTopic && sameBtwTopic(overlay?.selectedTopic, topic);
	const actions = displayingOverlay && overlay?.supported ? overlay.actions : [];
	usePresentationClaim(displayingOverlay && overlay?.supported ? { hostId, epoch: overlay.epoch, surfaceId: overlay.surfaceId, nodeId: overlay.nodeId } : null, !!presentation?.active, !!presentation?.available);
	const running = latest?.status === "running";
	const sideTurnRunning = topics.some(topic => topic.turns.at(-1)?.status === "running");
	const busy = context.busy !== null || !!closing;
	const disabled = !!readOnly || busy || !state;
	const scope = state ? { generation: state.generation, epoch: state.epoch } : null;
	const composerKey = context.activeComposer === `ask:${topicKey}` || context.activeComposer === `followUp:${topicKey}` ? context.activeComposer
		: drawer && !running && actions.includes(TSP_ACTIONS.btwFollowUp) ? `followUp:${topicKey}` : topics.length === 0 ? "ask:" : null;
	const composer = composerKey ? context.composers[composerKey] ?? { mode: composerKey.startsWith("followUp:") ? "followUp" as const : "ask" as const, draft: "", topic: topicRef, title: topic?.title ?? null } : null;
	const mode = composer?.mode;
	const draft = composer?.draft ?? "";
	const activeComposer = composer !== null;
	const error = context.error;
	const copied = context.copied;
	const savedDrafts = Object.entries(contexts).flatMap(([savedContextKey, savedContext]) => {
		const [savedHost, generation, epoch] = JSON.parse(savedContextKey) as [string, number | null, number | null];
		return Object.entries(savedContext.composers)
			.filter(([key, composer]) => composer.draft.trim() && !(savedContextKey === contextKey && key === composerKey))
			.map(([key, composer]) => ({ key: JSON.stringify([savedContextKey, key]), composer, origin: t("btw.savedDraftOrigin", { hostId: savedHost, generation, epoch }) }));
	});
	useEffect(() => { update(current => ({ ...current, copied: false })); }, [contextKey, topicKey, latest?.answer]);
	useEffect(() => { if (mode) input.current?.focus(); }, [contextKey, composerKey, mode]);
	useEffect(() => {
		if (follow.current && body.current) body.current.scrollTop = body.current.scrollHeight;
	}, [contextKey, topicKey, latest?.answer, topic?.turns.length]);
	const perform = async (action: () => Promise<unknown>, onSuccess?: (current: PaneContext) => PaneContext) => {
		if (operations.current.has(contextKey)) return false;
		const owner = Symbol();
		operations.current.set(contextKey, owner);
		update(current => ({ ...current, busy: owner, error: null }));
		try {
			await action();
			if (onSuccess) update(current => onSuccess(current));
			return true;
		} catch (error) {
			update(current => current.overlayKey === overlayKey && sameBtwTopic(current.selection, context.selection) ? { ...current, error: error instanceof Error ? error.message : String(error) } : current);
			return false;
		} finally {
			if (operations.current.get(contextKey) === owner) operations.current.delete(contextKey);
			update(current => current.busy === owner ? { ...current, busy: null } : current);
		}
	};
	const startComposer = (mode: "ask" | "followUp") => {
		if (disabled || operations.current.has(contextKey)) return;
		const key = `${mode}:${topicKey}`;
		update(current => ({ ...current, activeComposer: key, composers: { ...current.composers, [key]: current.composers[key] ?? { mode, draft: "", topic: topicRef, title: topic?.title ?? null } }, error: null }));
	};
	const submit = async () => {
		if (disabled || !draft.trim() || !scope || !composerKey || !composer || mode === "followUp" && (!topicRef || !displayingOverlay)) return;
		const sentComposer = context.composers[composerKey];
		await perform(() => mode === "followUp" && topicRef
			? window.vomp.invoke("btw:followUp", hostId, topicRef, draft, scope)
			: window.vomp.invoke("btw:ask", hostId, draft, scope), current => {
			if (current.composers[composerKey] !== sentComposer) return current;
			const composers = { ...current.composers };
			delete composers[composerKey];
			return { ...current, composers, activeComposer: current.activeComposer === composerKey && current.overlayKey === overlayKey && sameBtwTopic(current.selection, context.selection) ? null : current.activeComposer };
		});
	};
	const select = (key: string) => {
		if (busy || operations.current.has(contextKey)) return;
		const selected = topics.find(topic => btwTopicKey(topic) === key);
		if (!selected) return;
		const ref = { id: selected.id, ...(selected.scope !== undefined ? { scope: selected.scope } : {}) };
		update(current => ({ ...current, selection: ref, activeComposer: null, error: null }));
		follow.current = false;
		body.current?.scrollTo({ top: 0 });
		if (!historyOnly && !readOnly && overlay?.supported && overlay.topics.some(topic => sameBtwTopic(topic, ref)) && scope) void perform(() => window.vomp.invoke("btw:select", hostId, ref, scope));
	};
	const statusLabel = (status: BtwStatus) => t(`btw.status.${status}`);
	const copy = () => { if (topic) void perform(() => navigator.clipboard.writeText(topic.turns.map(turn => turn.answer).filter(Boolean).join("\n\n")), current => current.selection === context.selection && current.overlayKey === overlayKey ? { ...current, copied: true } : current); };
	return <section aria-label={t("names.btw")} className="flex min-h-0 flex-1 flex-col text-fg">
		<PaneToolbar className="h-auto min-h-9 flex-wrap gap-2 py-2">
			<Menu><MenuTrigger asChild><Button size="sm" variant="ghost" disabled={!topics.length || busy}>{t("btw.history", { count: topics.length })}</Button></MenuTrigger>
				<MenuContent aria-label={t("btw.historyLabel")} align="start"><MenuRadioGroup value={topicKey} onValueChange={select}>
					{topics.map(topic => <MenuRadioItem key={btwTopicKey(topic)} value={btwTopicKey(topic)} disabled={busy}><span className="max-w-64 truncate" title={topic.title}>{topic.title}</span></MenuRadioItem>)}
				</MenuRadioGroup></MenuContent>
			</Menu>
			{!historyOnly && <Button size="sm" variant="ghost" className="ml-auto" icon={<Plus />} disabled={disabled || sideTurnRunning || !!overlay?.followUp} onClick={() => startComposer("ask")}>{t("btw.new")}</Button>}
			{!historyOnly && !overlay && topics.length > 0 && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { void perform(() => window.vomp.invoke("btw:ask", hostId, "", scope!)); }}>{t("btw.openHistory")}</Button>}
		</PaneToolbar>
		<div ref={body} onScroll={() => { const element = body.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-md" tabIndex={0} aria-label={t("btw.answers")}>
			{!state && !loadError ? <p role="status" className="flex items-center gap-2 text-fg-muted"><Spinner />{t("btw.loading")}</p>
				: !topic ? <EmptyState icon={<ChatCircle />} title={t("btw.emptyTitle")} body={t("btw.empty")} />
				: <div className="flex flex-col gap-6">{topic.turns.map((turn, index) => <article key={`${topicKey}/${index}`} className="min-w-0" aria-label={index === 0 ? t("btw.question") : t("btw.followUp")}>
					<div className="mb-1 font-medium"><Markdown text={index === 0 ? topic.title : turn.question} /></div>
					<div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
						{index > 0 && <span>{t("btw.followUp")}</span>}
						{turn.createdAt > 0 && <time dateTime={new Date(turn.createdAt).toISOString()} title={new Date(turn.createdAt).toLocaleString()}>{new Date(turn.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>}
						<span role="status" className={turn.status === "error" ? "text-err" : turn.status === "running" ? "text-accent" : undefined}>{turn.status === "running" && <Spinner className="mr-1 inline-block" />}{statusLabel(turn.status)}</span>
					</div>
					{turn.answer ? turn.inject ? <BtwAnswerWithInject turn={turn} /> : turn.status === "running" ? <StreamingMarkdown text={turn.answer} /> : <Markdown text={turn.answer} /> : <p className="text-fg-muted">{t(turn.status === "running" ? "btw.thinking" : "btw.noAnswer")}</p>}
					{turn.error && <p role="alert" className="mt-3 whitespace-pre-wrap text-sm text-err">{turn.error}</p>}
					{turn.status === "interrupted" && <p className="mt-3 text-sm text-fg-muted">{t("btw.interrupted")}</p>}
				</article>)}</div>}
			{savedDrafts.length > 0 && <details className="mt-4 border-t border-border pt-3">
				<summary className="cursor-pointer text-sm text-fg-muted">{t("btw.savedDrafts", { count: savedDrafts.length })}</summary>
				<p className="mt-2 text-xs text-fg-muted">{t("btw.savedDraftHint")}</p>
				<ul className="mt-3 flex flex-col gap-4">{savedDrafts.map(saved => <li key={saved.key} className="min-w-0">
					<p className="text-sm font-medium">{t(saved.composer.mode === "followUp" ? "btw.followUpQuestion" : "btw.askQuestion")}{saved.composer.title && `: ${saved.composer.title}`}</p>
					<p className="break-words text-xs text-fg-muted">{saved.origin}</p>
					{saved.composer.topic && <p className="break-words text-xs text-fg-muted">{t("btw.savedDraftTopic", { id: saved.composer.topic.id, scope: saved.composer.topic.scope ?? t("btw.unscopedTopic") })}</p>}
					<pre tabIndex={0} aria-label={t("btw.savedDraftText")} className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">{saved.composer.draft}</pre>
					<Button size="sm" variant="ghost" disabled={busy} icon={<Copy />} onClick={() => { void perform(() => navigator.clipboard.writeText(saved.composer.draft)); }}>{t("btw.copyDraft")}</Button>
				</li>)}</ul>
			</details>}
		</div>
		{state?.overlay?.notice && <p role="status" className="shrink-0 px-4 pb-3 text-sm text-fg-muted">{state.overlay.notice}</p>}
		{(loadError || error) && <p role="alert" className="shrink-0 px-4 pb-3 text-sm text-err">{error ?? loadError}</p>}
		{topic && (!activeComposer || drawer || historyOnly) && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-2">
			{latest?.answer && <Button size="sm" variant="ghost" icon={<Copy />} disabled={busy} onClick={copy}>{t(copied ? "btw.copied" : "btw.copy")}</Button>}
			{!historyOnly && actions.includes(TSP_ACTIONS.btwStop) && <Button size="sm" variant="secondary" icon={<Stop />} disabled={disabled} onClick={() => { void perform(() => window.vomp.invoke("btw:stop", hostId, topicRef!, scope!)); }}>{t("btw.stop")}</Button>}
			{!historyOnly && actions.includes(TSP_ACTIONS.btwInject) && <Button size="sm" variant="secondary" disabled={disabled} onClick={() => { void perform(() => window.vomp.invoke("btw:inject", hostId, topicRef!, scope!)); }}>{t("btw.inject")}</Button>}
			{!historyOnly && !drawer && actions.includes(TSP_ACTIONS.btwFollowUp) && <Button size="sm" variant="secondary" className="ml-auto" disabled={disabled || running || !!overlay?.followUp} onClick={() => startComposer("followUp")}>{t("btw.followUp")}</Button>}
		</div>}
		{!historyOnly && activeComposer && <form className="flex shrink-0 flex-col gap-3 border-t border-border p-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
			<Textarea ref={input} label={t(mode === "followUp" ? "btw.followUpQuestion" : "btw.askQuestion")} placeholder={t(mode === "followUp" ? "btw.followUpPlaceholder" : "btw.placeholder")} value={draft} minRows={2} maxRows={5} disabled={disabled || mode === "followUp" && !displayingOverlay} onChange={event => { const draft = event.target.value; update(current => ({ ...current, composers: { ...current.composers, [composerKey!]: { ...composer!, draft } } })); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
			<div className="flex flex-wrap items-center justify-end gap-2">
				{topics.length > 0 && !drawer && <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
					const cancel = (current: PaneContext) => current.activeComposer === composerKey && current.overlayKey === overlayKey ? { ...current, activeComposer: null, error: null } : current;
					if (overlay?.followUp && displayingOverlay) void perform(() => window.vomp.invoke("btw:close", hostId, overlay.selectedTopic, scope!), cancel);
					else update(cancel);
				}}>{t("btw.cancel")}</Button>}
				<Button type="submit" size="sm" variant="primary" icon={busy ? <Spinner /> : <ArrowUp />} disabled={disabled || !draft.trim() || mode === "followUp" && !displayingOverlay}>{t(mode === "followUp" ? "btw.sendFollowUp" : "btw.ask")}</Button>
			</div>
		</form>}
		<p className="shrink-0 px-3 pb-3 text-xs text-fg-muted">{t(actions.includes(TSP_ACTIONS.btwInject) ? "btw.separateWithInject" : "btw.separate")}</p>
	</section>;
}

function BtwAnswerWithInject({ turn }: { turn: BtwTopic["turns"][number] }) {
	const { t } = useTranslation("panes");
	const parts = /^([\s\S]*?)<inject>\s*([\s\S]*?)\s*<\/inject>([\s\S]*)$/.exec(turn.answer);
	if (!parts || !turn.inject) return <Markdown text={turn.answer} />;
	return <div className="flex flex-col gap-3">
		{parts[1]?.trim() && <Markdown text={parts[1]} />}
		<div className="rounded-md bg-inset px-3 py-3"><p className="whitespace-pre-wrap">{turn.inject.text}</p><p className="mt-2 text-xs text-fg-muted">{t(turn.inject.sent ? "btw.injected" : "btw.steering")}</p></div>
		{parts[3]?.trim() && <Markdown text={parts[3]} />}
	</div>;
}
