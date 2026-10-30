import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import { unclaimed } from "@shared/tsp/view-state";
import { useEffect, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { TspInspector } from "../palette/TspInspector";
import { NodeView } from "./nodes/NodeView";
import type { NodeContext } from "./nodes/context";
import "./screen.css";

export interface OmpScreenProps {
	hostId: string;
	generation: number;
	snapshot: TspHostSnapshot | null;
	failed: boolean;
	readOnly: boolean;
	contentRef?: Ref<HTMLDivElement>;
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
		{surfaces.map(surface => {
			const disabled = readOnly || surface.closed || surface.suspended;
			const send = (event: TspRendererEvent) => { if (!disabled && typeof snapshot?.epoch === "number") report(window.vomp.invoke("host:tsp-event", hostId, generation, event, snapshot.epoch)); };
			const context: NodeContext = { sf: surface.open.id, hostId, readOnly: disabled, send, keys: data => { if (!disabled && typeof snapshot?.epoch === "number") report(window.vomp.invoke("host:keys", hostId, data, generation, snapshot.epoch)); }, render: node => <NodeView key={node.id} node={node} context={context} /> };
			const main = unclaimed(surface, "main");
			const dock = unclaimed(surface, "dock");
			const layer = unclaimed(surface, "layer");
			return <section key={surface.open.id} className="space-y-section">
				{surface.closed && <p className="text-sm text-fg-muted">{t("tsp.retained")}</p>}
				{layer.map(node => context.render(node))}{dock.map(node => context.render(node))}
				{surface.open.mode === "screen" ? main.map(node => context.render(node)) : main.length > 0 && <section className="space-y-stack"><h3 className="text-sm font-semibold text-fg-muted">{t("tsp.otherOutput")}</h3>{main.map(node => context.render(node))}</section>}
			</section>;
		})}
		<details className="mt-section border-t border-border pt-card" open={outline} onToggle={event => setOutline(event.currentTarget.open)}><summary className="cursor-pointer text-sm text-fg-muted">{t("tsp.rawOutline")}</summary>{outline && <div className="mt-card"><TspInspector hostId={hostId} generation={generation} /></div>}</details>
	</div>;
}
