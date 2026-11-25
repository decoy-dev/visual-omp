import { planChoice, planReview, planSavePrompt, type PlanAction, type TspPlanReview, type TspPlanSave } from "@shared/tsp/plan-review";
import { TSP_ACTIONS } from "@shared/tsp/roles";
import type { TspNode } from "@shared/tsp";
import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import type { SessionController } from "../../state/session";
import { useSessionView } from "../../shell/hooks";
import { useTsp } from "../../state/tsp/useTsp";
import { useEffect, useRef } from "react";
import { screenActivity } from "../../state/tsp/screen-activity";
import { openRequestedScreen } from "./drive";

/** Presence is physical: hidden or temporarily unsupported content still owns the pending choice. */
function physicalNodePresent(node: TspNode, id: string): boolean {
	return node.id === id || (node.c ?? []).some(child => physicalNodePresent(child, id));
}

/** A current document is the only source of plan decisions for TSP chats. */
export function useTspPlanReview(session: SessionController | null) {
	const view = useSessionView(session);
	const host = view?.host;
	const { snapshot, store } = useTsp(host?.transport === "tsp" ? host.hostId : null);
	const pending = useRef(new Set<() => void>());
	useEffect(() => () => { for (const cancel of pending.current) cancel(); pending.current.clear(); }, [store]);
	const current = (view?.mode === "live" || view?.mode === "starting") && host?.transport === "tsp" && snapshot?.hostId === host.hostId && snapshot.generation === host.generation && snapshot.negotiated && snapshot.lifecycle === "live";
	const surfaces = current ? snapshot.surfaces.filter(surface => surface.documentGeneration === host.generation) : [];
	// omp 18.22.0's Save prompt covers the review, which stays open beneath it; the card answers the prompt.
	const savePrompt = current ? planSavePrompt(surfaces) : null;
	const review = current ? planReview(surfaces) ?? savePrompt?.review ?? null : null;
	const disabled = !!view?.readOnly || !!snapshot?.closing;
	const assertCurrent = (): TspHostSnapshot => {
		const next = store.getSnapshot();
		const live = session?.getSnapshot();
		if (!snapshot || !next || next.hostId !== snapshot.hostId || next.epoch !== snapshot.epoch || next.generation !== snapshot.generation
			|| !next.negotiated || next.lifecycle !== "live" || next.closing || (live?.mode !== "live" && live?.mode !== "starting") || live?.readOnly || live?.host?.transport !== "tsp"
			|| live.host.hostId !== next.hostId || live.host.generation !== next.generation) throw new Error("The chat changed while applying the plan choice.");
		return next;
	};
	const liveReview = (target: TspPlanReview) => {
		const next = assertCurrent();
		const live = planReview(next.surfaces.filter(surface => surface.documentGeneration === next.generation));
		if (!live || live.id !== target.id || live.sf !== target.sf || live.committed) throw new Error("Plan Review is no longer available.");
		return { next, live };
	};
	const send = async (event: TspRendererEvent) => {
		if (!review) throw new Error("Plan Review is no longer available.");
		const { next, live } = liveReview(review);
		const validTabsSlider = live.slider?.kind === "tabs" && event.ev === "select" && event.id === live.slider.id && live.slider.items.some(item => item.id === event.item);
		const validMenuSlider = live.slider?.kind === "menu" && event.ev === "action" && event.id === live.slider.id && live.slider.items.some(item => item.id === event.act) && event.checked === true;
		if (event.sf !== live.sf || (!validTabsSlider && !validMenuSlider)) throw new Error("omp did not offer that plan tier.");
		const release = screenActivity.hold(next, "drive");
		const off = store.subscribe(() => { try { assertCurrent(); } catch { release(); } });
		const offSession = session!.subscribe(() => { try { assertCurrent(); } catch { release(); } });
		const cleanup = () => { release(); off(); offSession(); pending.current.delete(cleanup); };
		pending.current.add(cleanup);
		try { await window.vomp.invoke("host:tsp-event", next.hostId, next.generation, event, next.epoch); }
		finally { cleanup(); }
	};
	const choose = async (target: TspPlanReview, action: PlanAction | "discard") => {
		// Read again after any awaited permission-config change and construct input from this document.
		const { next, live } = liveReview(target);
		// omp 18.22.0 lists Refine only while its own review has annotations or deleted sections. Without them, Cancel closes
		// the review and keeps plan mode, as an earlier Refine without comments did; the card then asks for the comment.
		const closes = action === "discard" || (action === "refine" && !live.options.some(option => option.action === "refine"));
		const event = closes ? live.cancelId ? { ev: "action" as const, sf: live.sf, id: live.cancelId, act: TSP_ACTIONS.cancel } : null : planChoice(live, action);
		// Save (omp 18.22.0) keeps the review open under omp's own "Save plan" prompt. The card answers the recorded
		// prompt; any other covering prompt opens in the omp screen.
		const approval = action === "execute" || action === "compact" || action === "keep";
		const keepsReview = action === "saveCopy";
		let handoff = false;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const release = screenActivity.hold(next, action === "save" ? "request" : "drive");
		let off = () => {};
		let offSession = () => {};
		// An accepted approval can start omp's next context before the review leaves the document.
		let delivered = false;
		const cancel = () => {
			release(); off(); offSession(); pending.current.delete(cancel);
			if (delivered && approval) resolve();
			else reject(new Error("The plan review view closed."));
		};
		const check = () => {
			try {
				const latest = assertCurrent();
				const surface = latest.surfaces.find(surface => surface.open.id === live.sf && surface.documentGeneration === latest.generation);
				if (!surface || surface.closed || surface.suspended) throw new Error("The plan review surface changed while applying the choice.");
				if (!physicalNodePresent(surface.document, live.id)) resolve();
				else if (keepsReview) {
					const surfaces = latest.surfaces.filter(item => item.documentGeneration === latest.generation);
					if (planReview(surfaces)?.id !== live.id) { handoff = planSavePrompt(surfaces)?.review.id !== live.id; resolve(); }
				}
			} catch (error) { release(); off(); offSession(); pending.current.delete(cancel); reject(error); }
		};
		pending.current.add(cancel);
		off = store.subscribe(check);
		offSession = session!.subscribe(check);
		try {
			const write = event ? window.vomp.invoke("host:tsp-event", next.hostId, next.generation, event, next.epoch)
				: window.vomp.invoke("host:keys", next.hostId, "escape", next.generation, next.epoch);
			void write.then(() => { delivered = true; }, () => {});
			check();
			await Promise.all([write, promise]);
			// Queue only after the physical review has left, or once an unrecognized prompt covers it; the watcher owns the post-layout opening.
			if ((action === "save" || handoff) && session) openRequestedScreen(session, assertCurrent());
		} finally { release(); off(); offSession(); pending.current.delete(cancel); }
	};
	/**
	 * Answers omp's "Save plan" prompt: an empty path keeps omp's default name. Every write first reads the prompt
	 * again; Save goes only after omp shows the typed path. Resolves once the prompt has closed.
	 */
	const answerSave = async (target: TspPlanSave, choice: { path: string } | "cancel") => {
		const livePrompt = () => {
			const next = assertCurrent();
			const live = planSavePrompt(next.surfaces.filter(surface => surface.documentGeneration === next.generation))?.save;
			if (!live || live.id !== target.id || live.sf !== target.sf || live.inputId !== target.inputId) throw new Error("omp's Save plan prompt is no longer open.");
			return { next, live };
		};
		const first = livePrompt();
		const path = choice === "cancel" ? "" : choice.path.trim();
		const release = screenActivity.hold(first.next, "drive");
		/** Resolves when `ready` holds and rejects when it throws, the view closes or `ms` pass. */
		const until = (ready: () => boolean, ms: number | null, timeout: string): Promise<void> => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			let off = () => {};
			let offSession = () => {};
			let timer: number | undefined;
			const stop = () => { off(); offSession(); window.clearTimeout(timer); pending.current.delete(fail); };
			const fail = () => { stop(); reject(new Error("The plan review view closed.")); };
			const check = () => { try { if (ready()) { stop(); resolve(); } } catch (error) { stop(); reject(error); } };
			pending.current.add(fail);
			off = store.subscribe(check);
			offSession = session!.subscribe(check);
			if (ms !== null) timer = window.setTimeout(() => { stop(); reject(new Error(timeout)); }, ms);
			check();
			return promise;
		};
		const write = (event: TspRendererEvent, next: TspHostSnapshot) => window.vomp.invoke("host:tsp-event", next.hostId, next.generation, event, next.epoch);
		try {
			if (choice === "cancel") await write({ ev: "action", sf: first.live.sf, id: first.live.cancelId, act: TSP_ACTIONS.cancel }, first.next);
			else {
				if (path !== first.live.text) {
					const { next, live } = livePrompt();
					await write({ ev: "edit", sf: live.sf, id: live.inputId, from: 0, to: live.text.length, text: path, cursor: path.length, len: live.text.length }, next);
					await until(() => livePrompt().live.text === path, 2_000, "omp did not take that file name. The plan was not saved.");
				}
				const { next, live } = livePrompt();
				if (live.text !== path) throw new Error("omp's Save plan prompt changed. The plan was not saved.");
				await write({ ev: "action", sf: live.sf, id: live.saveId, act: TSP_ACTIONS.save }, next);
			}
			await until(() => {
				const latest = assertCurrent();
				const surface = latest.surfaces.find(surface => surface.open.id === target.sf && surface.documentGeneration === latest.generation);
				if (!surface || surface.closed || surface.suspended) throw new Error("The plan review surface changed while saving the plan.");
				return !physicalNodePresent(surface.document, target.id);
			}, null, "");
		} finally { release(); }
	};
	return { review, savePrompt: savePrompt?.save ?? null, disabled, choose, answerSave, send, assertCurrent, snapshot };
}
