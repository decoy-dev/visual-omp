import { planChoice, planReview, type PlanAction, type TspPlanReview } from "@shared/tsp/plan-review";
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
	const review = current ? planReview(snapshot.surfaces.filter(surface => surface.documentGeneration === host.generation)) : null;
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
		if (event.ev !== "select" || event.sf !== live.sf || event.id !== live.slider?.id || !live.slider.items.some(item => item.id === event.item)) throw new Error("omp did not offer that plan tier.");
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
		const event = action === "discard" ? live.cancelId ? { ev: "action" as const, sf: live.sf, id: live.cancelId, act: TSP_ACTIONS.cancel } : null : planChoice(live, action);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const release = screenActivity.hold(next, action === "save" ? "request" : "drive");
		let off = () => {};
		let offSession = () => {};
		const cancel = () => { release(); off(); offSession(); pending.current.delete(cancel); reject(new Error("The plan review view closed.")); };
		const check = () => {
			try {
				const latest = assertCurrent();
				const surface = latest.surfaces.find(surface => surface.open.id === live.sf && surface.documentGeneration === latest.generation);
				if (!surface || surface.closed || surface.suspended) throw new Error("The plan review surface changed while applying the choice.");
				if (!physicalNodePresent(surface.document, live.id)) resolve();
			} catch (error) { release(); off(); offSession(); pending.current.delete(cancel); reject(error); }
		};
		pending.current.add(cancel);
		off = store.subscribe(check);
		offSession = session!.subscribe(check);
		try {
			const write = event ? window.vomp.invoke("host:tsp-event", next.hostId, next.generation, event, next.epoch)
				: window.vomp.invoke("host:keys", next.hostId, "escape", next.generation, next.epoch);
			check();
			await Promise.all([write, promise]);
			const latest = assertCurrent();
			// Queue only after the physical review has left; the watcher owns the post-layout opening.
			if (action === "save" && session) openRequestedScreen(session, latest);
		} finally { release(); off(); offSession(); pending.current.delete(cancel); }
	};
	return { review, disabled, choose, send, assertCurrent, snapshot };
}
