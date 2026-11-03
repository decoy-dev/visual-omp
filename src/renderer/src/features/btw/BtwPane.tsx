import { ChatCircle } from "@phosphor-icons/react";
import { createContext, useContext, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { projectBtw, type BtwProjection } from "@shared/tsp/btw";
import { lazyView } from "../../registry/lazy";
import type { PaneProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { setPaneLeaveGuard } from "../../registry/guards";
import { useApp } from "../../state/app";
import { type PresentationTarget, usePresentationClaim } from "../../state/tsp/presentation-claims";
import { useTsp } from "../../state/tsp/useTsp";
import { Markdown, StreamingMarkdown } from "../../transcript/Markdown";
import { EmptyState, Spinner } from "../../ui";
import { usePaneVisible } from "../panes/common";

interface BtwPresentation {
	tabId: string;
	hostId: string;
	generation: number;
	epoch: number | undefined;
	readOnly: boolean;
	projection: BtwProjection | null;
	target: PresentationTarget | null;
	presentation: { active: boolean; available: boolean };
}
export const BtwPresentation = createContext<BtwPresentation | null>(null);
/** Keep the document presentation eager while interactive history and composer controls load. */
export const BtwContent = lazyView(() => import("./BtwPaneContent").then(module => module.BtwPaneHost), BtwPaneLoading);

export function BtwPane({ session }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const visible = usePaneVisible("btw");
	const host = view?.host?.transport === "tsp" ? view.host : null;
	const { snapshot, store } = useTsp(host?.hostId ?? null);
	const current = snapshot?.lifecycle === "live" && snapshot.generation === host?.generation && snapshot.epoch === host?.tspEpoch;
	const projection = current ? projectBtw(snapshot.surfaces.filter(surface => surface.documentGeneration === host?.generation)) : null;
	const terminalOpen = useApp(app => app.terminalTabId === session?.tabId);
	useLayoutEffect(() => {
		if (!session || !host || !visible || !projection) return;
		return setPaneLeaveGuard(session.tabId, () => import("./BtwPaneContent")
			.then(module => module.putAwayBtwPanel(session, host, projection, store))
			.then(() => true, () => false));
	}, [session, host, visible, projection, store]);
	if (!session || !host) return <EmptyState icon={<ChatCircle />} title={t("btw.noChatTitle")} body={t("btw.noChat")} />;
	const target = projection && snapshot ? { hostId: snapshot.hostId, epoch: snapshot.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId } : null;
	return <BtwPresentation.Provider value={{ tabId: session.tabId, hostId: host.hostId, generation: host.generation, epoch: host.tspEpoch,
		readOnly: !!view?.readOnly || host.phase !== "live", projection, target,
		presentation: { active: visible && !terminalOpen, available: visible } }}><BtwContent /></BtwPresentation.Provider>;
}

/** A cold chunk or pending history subscription still presents and claims the exact document. */
export function BtwPaneLoading() {
	const { t } = useTranslation("panes");
	const content = useContext(BtwPresentation);
	const projection = content?.projection;
	usePresentationClaim(projection?.supported ? content?.target ?? null : null, !!content?.presentation.active, !!content?.presentation.available);
	if (!projection) return <p role="status" className="flex items-center gap-2 p-4 text-fg-muted"><Spinner />{t("btw.loading")}</p>;
	return <section aria-label={t("names.btw")} aria-busy="true" className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-md">
		{projection.turns.length ? <div className="flex flex-col gap-6">{projection.turns.map((turn, index) => <article key={index} aria-label={t(index === 0 ? "btw.question" : "btw.followUp")}>
			<div className="mb-1 font-medium"><Markdown text={turn.question} /></div>
			<p role="status" className="mb-3 text-xs text-fg-muted">{t(`btw.status.${turn.status}`)}</p>
			{turn.answer ? <StreamingMarkdown text={turn.answer} /> : <p className="text-fg-muted">{t("btw.thinking")}</p>}
		</article>)}</div> : <EmptyState icon={<ChatCircle />} title={t("btw.emptyTitle")} body={t("btw.empty")} />}
		{projection.field?.text && <p className="mt-3 whitespace-pre-wrap text-fg-muted">{projection.field.text}</p>}
		{projection.notice && <p role="status" className="mt-3 text-fg-muted">{projection.notice}</p>}
	</section>;
}
