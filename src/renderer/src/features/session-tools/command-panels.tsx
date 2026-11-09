import { useEffect, useRef } from "react";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { commandReport } from "@shared/tsp/reports";
import { settledCommandPanel } from "@shared/tsp/command-panels";
import { region, walkNodes } from "@shared/tsp/view-state";
import type { SessionController } from "../../state/session";
import { tspHost } from "../../state/tsp/hosts";
import { presentationClaims, usePresentationClaim } from "../../state/tsp/presentation-claims";
import { useTsp } from "../../state/tsp/useTsp";
import { addCommandResult, roomKey, type CommandResultRecord } from "./results";

const collectors = new WeakMap<SessionController, () => void>();
const closedReports = new WeakSet<object>();

/** Independent of editor readiness: panel questions can close before the outcome arrives. */
export function startCommandPanels(session: SessionController, line: string, baseline: TspHostSnapshot, anchor: string | null, room: string | null): () => void {
	collectors.get(session)?.();
	const guest = session.guestClient();
	const source = tspHost(baseline.hostId);
	const previous = new Map<string, string>();
	const delivered = new Set<string>();
	for (const surface of baseline.surfaces) for (const area of ["layer", "dock"] as const) for (const root of region(surface, area)) for (const node of walkNodes(root)) previous.set(JSON.stringify([surface.open.id, node.id]), JSON.stringify(node));
	let disposed = false;
	const stop = () => { if (disposed) return; disposed = true; offTsp(); offSession(); offEvents(); if (collectors.get(session) === stop) collectors.delete(session); };
	const accept = () => {
		if (disposed) return;
		const view = session.getSnapshot();
		const snapshot = source.getSnapshot();
		if (view.mode !== "live" || view.host?.hostId !== baseline.hostId || view.host.generation !== baseline.generation || session.guestClient() !== guest || roomKey(view) !== room
			|| snapshot && (snapshot.hostId !== baseline.hostId || snapshot.epoch !== baseline.epoch || snapshot.generation !== baseline.generation || snapshot.lifecycle !== "live" || snapshot.closing)) { stop(); return; }
		if (!snapshot?.negotiated) return;
		for (const surface of snapshot.surfaces) {
			if (surface.closed || surface.suspended || surface.documentGeneration !== baseline.generation) continue;
			for (const area of ["layer", "dock"] as const) for (const root of region(surface, area)) for (const node of walkNodes(root)) {
				const key = JSON.stringify([surface.open.id, node.id]);
				const text = JSON.stringify(node);
				if (previous.get(key) === text || delivered.has(key)) continue;
				const report = commandReport(node);
				const panel = settledCommandPanel(node);
				if (!report && (!panel || line.trim().split(/\s/, 1)[0] !== panel.command.split(/\s/, 1)[0])) continue;
				const lines = report?.lines ?? panel!.lines;
				addCommandResult(session, {
					command: line, lines, title: report?.title, tone: panel?.status === "error" ? "err" : panel?.status === "warning" || panel?.status === "cancelled" ? "warn" : "info", anchor, room,
					markdown: report?.markdown,
					...(panel?.path ? { locations: [{ kind: "path" as const, value: panel.path }] } : {}),
					panel: { hostId: baseline.hostId, epoch: baseline.epoch, generation: baseline.generation, surfaceId: surface.open.id, nodeId: node.id, text, ...(report ? { close: report.close } : {}) },
				});
				delivered.add(key);
			}
		}
	};
	const offTsp = source.subscribe(accept);
	const offSession = session.subscribe(accept);
	const offEvents = session.onEvent(event => { if (event.kind === "disposed" || event.kind === "exited" || event.kind === "sent") stop(); });
	collectors.set(session, stop);
	return stop;
}

/** Ownership starts only after its Result row mounts in a visible chat. */
export function CommandPanelOwnership({ result, onRelease }: { result: CommandResultRecord; onRelease: () => void }) {
	const panel = result.panel;
	const { snapshot } = useTsp(panel?.hostId ?? null);
	const surface = snapshot?.surfaces.find(item => item.open.id === panel?.surfaceId && !item.closed && !item.suspended && item.documentGeneration === panel?.generation);
	const node = surface ? [...walkNodes(surface.document)].find(item => item.id === panel?.nodeId) : undefined;
	const current = !!panel && !!snapshot?.negotiated && snapshot.hostId === panel.hostId && snapshot.epoch === panel.epoch && snapshot.generation === panel.generation && snapshot.lifecycle === "live" && !snapshot.closing && !!node && JSON.stringify(node) === panel.text;
	const target = current ? { hostId: panel.hostId, epoch: panel.epoch, surfaceId: panel.surfaceId, nodeId: panel.nodeId } : null;
	usePresentationClaim(target, current);
	const sent = useRef(false);
	const release = useRef(onRelease); release.current = onRelease;
	useEffect(() => {
		// A changed live subtree returns to fallback in full. Closed panels retain their saved Result.
		if (panel && node && snapshot?.epoch === panel.epoch && snapshot.generation === panel.generation && !current) release.current();
	}, [panel, node, snapshot, current]);
	useEffect(() => {
		if (!panel || !target || !panel.close || sent.current) return;
		const owned = presentationClaims.getSnapshot().some(item => item.hostId === target.hostId && item.epoch === target.epoch && item.surfaceId === target.surfaceId && item.nodeId === target.nodeId);
		if (!owned) return;
		sent.current = true;
		const latest = tspHost(panel.hostId).getSnapshot();
		const latestSurface = latest?.surfaces.find(item => item.open.id === panel.surfaceId && !item.closed && !item.suspended);
		const latestNode = latestSurface ? [...walkNodes(latestSurface.document)].find(item => item.id === panel.nodeId) : undefined;
		if (!latest?.negotiated || latest.hostId !== panel.hostId || latest.epoch !== panel.epoch || latest.generation !== panel.generation || latest.lifecycle !== "live" || latest.closing || !latestNode || JSON.stringify(latestNode) !== panel.text) return;
		if (closedReports.has(panel)) return;
		closedReports.add(panel);
		void window.vomp.invoke("host:tsp-event", panel.hostId, panel.generation, { ev: "action", sf: panel.surfaceId, id: panel.close.id, act: panel.close.act }, panel.epoch).catch(() => {
			const after = tspHost(panel.hostId).getSnapshot();
			const afterSurface = after?.surfaces.find(item => item.open.id === panel.surfaceId && !item.closed && !item.suspended && item.documentGeneration === panel.generation);
			const afterNode = afterSurface ? [...walkNodes(afterSurface.document)].find(item => item.id === panel.nodeId) : undefined;
			if (after?.hostId === panel.hostId && after.epoch === panel.epoch && after.generation === panel.generation && after.lifecycle === "live" && !after.closing && afterNode && JSON.stringify(afterNode) === panel.text) release.current();
		});
	}, [panel, target]);
	return null;
}
