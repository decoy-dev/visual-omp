import { createContext, useContext, useRef } from "react";
import { useTranslation } from "react-i18next";
import { projectBtw, type BtwProjection } from "@shared/tsp/btw";
import { lazyView } from "../../registry/lazy";
import { useSessionView } from "../../shell/hooks";
import { useApp } from "../../state/app";
import { type PresentationTarget, usePresentationClaim } from "../../state/tsp/presentation-claims";
import { useTsp } from "../../state/tsp/useTsp";
import { Spinner } from "../../ui";
import type { SessionController } from "../../state/session";

interface BtwPresentation {
	tabId: string;
	hostId: string;
	generation: number;
	epoch: number | undefined;
	readOnly: boolean;
	projection: BtwProjection | null;
	target: PresentationTarget | null;
	presentation: { active: boolean; available: boolean };
	drawer?: boolean;
}
export const BtwPresentation = createContext<BtwPresentation | null>(null);
/** Keep the document presentation eager while interactive history and composer controls load. */
export const BtwDrawerContent = lazyView(() => import("./BtwPaneContent").then(module => module.BtwDrawerHost), BtwDrawerLoading);

export function useBtwPresentation(session: SessionController | null) {
	const view = useSessionView(session);
	const host = view?.host?.transport === "tsp" ? view.host : null;
	const { snapshot } = useTsp(host?.hostId ?? null);
	const current = snapshot?.lifecycle === "live" && snapshot.generation === host?.generation && snapshot.epoch === host?.tspEpoch;
	const projection = current ? projectBtw(snapshot.surfaces.filter(surface => surface.documentGeneration === host?.generation)) : null;
	const target = projection && snapshot ? { hostId: snapshot.hostId, epoch: snapshot.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId } : null;
	return { view, host, projection, target };
}

/** History has no live-presentation deadline and can load with the interactive BTW chunk. */
export const BtwPane = lazyView(() => import("./BtwPaneContent").then(module => module.BtwHistoryHost));

/** Exact claims stay eager while the drawer's controls and history remain in the BTW chunk. */
export function BtwDrawer({ session }: { session: SessionController }) {
	const { view, host, projection, target } = useBtwPresentation(session);
	const requested = useApp(app => !!app.btwDrawers[session.tabId]);
	const terminalOpen = useApp(app => app.terminalTabId === session.tabId);
	const open = !!host && !view?.readOnly && (requested || !!projection?.supported);
	const mounted = useRef(false);
	mounted.current ||= open;
	usePresentationClaim(projection?.supported ? target : null, open && !terminalOpen, open);
	if (!host || !mounted.current) return null;
	return <BtwPresentation.Provider value={{ tabId: session.tabId, hostId: host.hostId, generation: host.generation, epoch: host.tspEpoch,
		readOnly: !!view?.readOnly || host.phase !== "live", projection, target, drawer: true,
		presentation: { active: open && !terminalOpen, available: open } }}><BtwDrawerContent /></BtwPresentation.Provider>;
}

function BtwDrawerLoading() {
	return <div data-btw-drawer className="absolute inset-x-3 bottom-3 z-20 flex h-[min(75%,42rem)] flex-col overflow-hidden rounded-lg border border-border bg-panel"><BtwPaneLoading /></div>;
}

/** The eager drawer owns the claim while a pending subscription presents the exact document text. */
export function BtwPaneLoading() {
	const { t } = useTranslation("panes");
	const content = useContext(BtwPresentation);
	const projection = content?.projection;
	if (!projection) return <p role="status" className="flex items-center gap-2 p-4 text-fg-muted"><Spinner />{t("btw.loading")}</p>;
	return <section aria-label={t("names.btw")} aria-busy="true" className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-md">
		{projection.turns.length ? <div className="flex flex-col gap-6">{projection.turns.map((turn, index) => <article key={index} aria-label={t(index === 0 ? "btw.question" : "btw.followUp")}>
			<p className="mb-1 whitespace-pre-wrap font-medium">{turn.question}</p>
			<p role="status" className="mb-3 text-xs text-fg-muted">{t(`btw.status.${turn.status}`)}</p>
			<p className="whitespace-pre-wrap">{turn.answer || t("btw.thinking")}</p>
		</article>)}</div> : <p className="text-fg-muted">{t("btw.emptyTitle")}</p>}
		{projection.field?.text && <p className="mt-3 whitespace-pre-wrap text-fg-muted">{projection.field.text}</p>}
		{projection.notice && <p role="status" className="mt-3 text-fg-muted">{projection.notice}</p>}
	</section>;
}
