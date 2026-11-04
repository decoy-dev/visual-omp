import type { TspNode } from "@shared/tsp";
import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { useTsp } from "../../state/tsp/useTsp";

/** The outline deliberately gives every kind the same read-only treatment, including future kinds. */
function NodeOutline({ node }: { node: TspNode }) {
	const { t } = useTranslation("palette");
	return (
		<li className="space-y-2 border-l border-border pl-card">
			<code className="break-all text-fg">{node.k} #{node.id}</code>
			<dl>
				<dt className="text-fg-muted">{t("tsp.props")}</dt>
				<dd><pre className="whitespace-pre-wrap break-words font-mono text-code">{JSON.stringify(node.p ?? {}, null, 2)}</pre></dd>
			</dl>
			{node.c && node.c.length > 0 && (
				<ul className="space-y-stack">
					{node.c.map(child => <NodeOutline key={child.id} node={child} />)}
				</ul>
			)}
		</li>
	);
}

/** Shows the shared document only within this host generation. */
export function TspInspector({ hostId, generation, ref }: { hostId: string; generation: number; ref?: Ref<HTMLDivElement> }) {
	const { t } = useTranslation("palette");
	const { snapshot, failed } = useTsp(hostId);
	// The shared document may still hold the previous generation; never show it here.
	const current = snapshot?.hostId === hostId && snapshot.generation === generation ? snapshot : null;
	const documentsCurrent = current?.lifecycle === "live" && current.negotiated && current.documentGeneration === generation;
	const surfaces = documentsCurrent ? current.surfaces.filter(surface => surface.documentGeneration === generation) : [];
	const retained = current && surfaces.length < current.surfaces.length;
	let status = current ? `tsp.${current.lifecycle}` : "tsp.waiting";
	if (current?.lifecycle === "live") status = !current.negotiated ? "tsp.negotiating" : surfaces.length > 0 ? "tsp.live" : "tsp.waiting";
	return (
		<div ref={ref} role="region" aria-label={t("tsp.outline")} tabIndex={0} className="h-full overflow-auto rounded-sm bg-overlay p-card text-sm text-fg">
			<p className="mb-stack text-fg-muted">{t("tsp.inspectorHint")}</p>
			<p className="mb-section text-fg-muted">{t("tsp.recovery")}</p>
			{!current ? <p role="status" className="text-fg-muted">{t(failed ? "tsp.unavailable" : "tsp.waiting")}</p> : (
				<div className="space-y-section">
					<p role="status" className="text-fg-muted">
						{t(status)}
					</p>
					{retained && <p className="text-fg-muted">{t("tsp.stale")}</p>}
					{current.failure && <p className="whitespace-pre-wrap break-words text-fg">{current.failure}</p>}
					<pre className="whitespace-pre-wrap break-words font-mono text-code text-fg-muted">{JSON.stringify({ lifecycle: current.lifecycle, generation: current.generation, documentGeneration: current.documentGeneration, negotiated: current.negotiated, revision: current.revision }, null, 2)}</pre>
					{surfaces.map(surface => (
						<section key={surface.open.id} aria-label={surface.open.id} className="space-y-stack">
							<h3 className="break-all text-md font-semibold">{surface.open.title ?? surface.open.id}</h3>
							<dl className="space-y-stack">
								<div>
									<dt className="text-fg-muted">{t("tsp.open")}</dt>
									<dd><pre className="whitespace-pre-wrap break-words font-mono text-code">{JSON.stringify(surface.open, null, 2)}</pre></dd>
								</div>
								<div>
									<dt className="text-fg-muted">{t("tsp.state")}</dt>
									<dd><pre className="whitespace-pre-wrap break-words font-mono text-code">{JSON.stringify({ sequence: surface.sequence, focus: surface.focus, suspended: surface.suspended, closed: surface.closed, settled: surface.settled }, null, 2)}</pre></dd>
								</div>
							</dl>
							<ul><NodeOutline node={surface.document} /></ul>
						</section>
					))}
				</div>
			)}
		</div>
	);
}
