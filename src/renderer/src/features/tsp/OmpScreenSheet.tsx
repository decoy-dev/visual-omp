import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import type { TspNode } from "@shared/tsp";
import { unclaimed } from "@shared/tsp/view-state";
import { useEffect, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { TspInspector } from "../palette/TspInspector";
import { NodeView } from "./nodes/NodeView";
import type { NodeContext } from "./nodes/context";
import { usePresentationClaims } from "../../state/tsp/presentation-claims";
import { useCommandFeedbackClaims } from "../session-tools/results";
import "./screen.css";

export interface OmpScreenProps {
	hostId: string;
	generation: number;
	snapshot: TspHostSnapshot | null;
	failed: boolean;
	readOnly: boolean;
	contentRef?: Ref<HTMLDivElement>;
}

/** omp retains empty layout containers when no menu is open. They are not readable output. */
function hasVisibleContent(node: TspNode): boolean {
	if (node.p?.hidden || node.k === "spacer" || node.k === "rule") return false;
	if (node.k === "col" || node.k === "row") return node.c?.some(hasVisibleContent) ?? false;
	return true;
}
/** Semantic content inside the existing terminal sheet frame. Main owns protocol housekeeping. */
export function OmpScreenSheet({ hostId, generation, snapshot, failed, readOnly, contentRef }: OmpScreenProps) {
	const { t } = useTranslation("palette");
	const [error, setError] = useState<string | null>(null);
	const [outline, setOutline] = useState(false);
	const content = useRef<HTMLDivElement | null>(null);
	useEffect(() => { content.current?.focus(); }, []);
	const current = snapshot?.hostId === hostId && snapshot.generation === generation && snapshot.lifecycle === "live" && snapshot.negotiated;
	const surfaces = current ? snapshot.surfaces.filter(surface => surface.documentGeneration === generation).sort((a, b) => Number(b.open.mode === "screen") - Number(a.open.mode === "screen")) : [];
	const claims = usePresentationClaims(hostId, snapshot?.epoch);
	const feedback = useCommandFeedbackClaims(hostId, snapshot?.epoch, generation);
	const empty = current && surfaces.length > 0 && !surfaces.some(surface =>
		["layer", "dock", "main"].some(region => unclaimed(surface, region as "layer" | "dock" | "main", claims.get(surface.open.id), feedback.get(surface.open.id)).some(hasVisibleContent)));
	const report = (promise: Promise<unknown>) => { void promise.catch(error => setError(error instanceof Error ? error.message : String(error))); };
	useEffect(() => {
		const element = content.current;
		if (!element || readOnly || typeof ResizeObserver === "undefined") return;
		let last = 0;
		const observer = new ResizeObserver(() => {
			const mono = document.createElement("span"); mono.textContent = "0000000000"; mono.className = "font-mono absolute invisible"; element.append(mono);
			const cell = mono.getBoundingClientRect().width / 10; mono.remove();
			const cols = cell > 0 ? Math.max(20, Math.floor(element.clientWidth / cell)) : 0;
			if (cols && cols !== last) { last = cols; report(window.vomp.invoke("host:tsp-resize", hostId, cols)); }
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [hostId, readOnly]);
	return <div ref={element => { content.current = element; if (typeof contentRef === "function") contentRef(element); else if (contentRef) contentRef.current = element; }} role="region" aria-label={t("tsp.title")} tabIndex={0} className="tsp-screen h-full overflow-auto rounded-sm bg-overlay p-card text-md text-fg">
		{error && <p role="alert" className="mb-card whitespace-pre-wrap break-words text-err">{error}</p>}
		{!current && <p role="status" className="text-fg-muted">{snapshot?.failure ?? t(failed ? "tsp.unavailable" : snapshot ? `tsp.${snapshot.lifecycle}` : "tsp.waiting")}</p>}
		{snapshot?.lifecycle === "exited" && <p className="mt-card text-fg-muted">{t("tsp.recovery")}</p>}
		{current && !surfaces.length && <p role="status" className="text-fg-muted">{t("tsp.waiting")}</p>}
		{empty && <div role="status" className="space-y-stack py-section"><p className="font-medium">{t("tsp.emptyScreenTitle")}</p><p className="text-fg-muted">{t("tsp.emptyScreenHint")}</p></div>}
		{surfaces.map(surface => {
			const disabled = readOnly || !!snapshot?.closing || surface.closed || surface.suspended;
			const send = (event: TspRendererEvent) => { if (!disabled && typeof snapshot?.epoch === "number") report(window.vomp.invoke("host:tsp-event", hostId, generation, event, snapshot.epoch)); };
			const context: NodeContext = { sf: surface.open.id, hostId, generation, epoch: snapshot?.epoch, readOnly: disabled, closing: snapshot?.closing, questionMatches: snapshot?.questionMatches, answer: async answer => {
				if (disabled || !snapshot) throw new Error("omp screen: The session changed or its semantic UI is not ready.");
				await window.vomp.invoke("host:tsp-answer", hostId, generation, answer, snapshot.epoch);
			}, send, keys: data => { if (!disabled && typeof snapshot?.epoch === "number") report(window.vomp.invoke("host:keys", hostId, data, generation, snapshot.epoch)); }, render: node => <NodeView key={node.id} node={node} context={context} /> };
			const claimed = claims.get(surface.open.id);
			const main = unclaimed(surface, "main", claimed, feedback.get(surface.open.id));
			const dock = unclaimed(surface, "dock", claimed);
			const layer = unclaimed(surface, "layer", claimed);
			return <section key={`${snapshot!.epoch}:${generation}:${surface.open.id}`} className="space-y-section">
				{surface.closed && <p className="text-sm text-fg-muted">{t("tsp.retained")}</p>}
				{layer.map(node => context.render(node))}{dock.map(node => context.render(node))}
				{surface.open.mode === "screen" ? main.map(node => context.render(node)) : main.length > 0 && <section className="space-y-stack"><h3 className="text-sm font-semibold text-fg-muted">{t("tsp.otherOutput")}</h3>{main.map(node => context.render(node))}</section>}
			</section>;
		})}
		<details className="mt-section border-t border-border pt-card" open={outline} onToggle={event => setOutline(event.currentTarget.open)}><summary className="cursor-pointer text-sm text-fg-muted">{t("tsp.rawOutline")}</summary>{outline && <div className="mt-card"><TspInspector hostId={hostId} generation={generation} /></div>}</details>
	</div>;
}
