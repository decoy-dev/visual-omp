/** Keep native presentation mounted across the interactive card's lazy chunk boundary. */
import { planReview } from "@shared/tsp/plan-review";
import { createContext, type PropsWithChildren, useContext } from "react";
import { useTranslation } from "react-i18next";
import { LoadFailedNotice, type LoadFailureProps } from "../../registry/lazy";
import type { ChatSlotProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { useApp } from "../../state/app";
import { type PresentationTarget, usePresentationClaim } from "../../state/tsp/presentation-claims";
import { useTsp } from "../../state/tsp/useTsp";
import { Card } from "../../ui";
import { currentHook } from "./ompDialogTsp";

interface LoadingContent { label: string; title: string; paragraphs: string[]; options: { id: string; label: string; description?: string | null }[] }
const Content = createContext<LoadingContent | null>(null);

/** A stable slot owns the readable document before loading and throughout the card's first subscription. */
export function NativeCardPresentation({ session, kind, children }: PropsWithChildren<ChatSlotProps & { kind: "plan" | "dialog" }>) {
	const { t } = useTranslation("session");
	const view = useSessionView(session);
	const host = view?.host;
	const { snapshot } = useTsp(host?.transport === "tsp" ? host.hostId : null);
	const covered = useApp(state => !!state.terminalTabId || !!state.sheet);
	const live = view?.mode === "live" || view?.mode === "starting";
	let target: PresentationTarget | null = null;
	let content: LoadingContent | null = null;
	if (live && host?.transport === "tsp" && snapshot) {
		if (kind === "plan") {
			const current = snapshot.hostId === host.hostId && snapshot.generation === host.generation && snapshot.negotiated && snapshot.lifecycle === "live";
			const review = current ? planReview(snapshot.surfaces.filter(surface => surface.documentGeneration === host.generation)) : null;
			if (review) {
				target = { hostId: snapshot.hostId, epoch: snapshot.epoch, surfaceId: review.sf, nodeId: review.id };
				content = { label: t("plan.aria"), title: review.title || t("plan.untitled"), paragraphs: [review.body], options: review.options };
			}
		} else {
			const hook = currentHook(snapshot, host.hostId, host.generation);
			const status = snapshot.questionMatches?.find(match => match.surfaceId === hook?.surface.open.id && match.nodeId === hook?.node.id)?.status ?? "unavailable";
			if (hook && status !== "matched") {
				target = { hostId: snapshot.hostId, epoch: snapshot.epoch, surfaceId: hook.surface.open.id, nodeId: hook.node.id };
				const dialog = hook.dialog;
				content = { label: t("ompDialog.aria"), title: dialog.title, paragraphs: dialog.body.kind === "select" ? dialog.detail : [...dialog.detail, dialog.body.value],
					options: dialog.body.kind === "select" ? dialog.body.options : [] };
			}
		}
	}
	// Layout registration precedes the watcher's passive opening decision. Keeping it outside Suspense
	// also covers the loaded card's initial snapshot read, when its own claim is not registered yet.
	usePresentationClaim(target, !covered, true);
	return <Content.Provider value={content}>{children}</Content.Provider>;
}

/** The current document stays readable without introducing a second answer path or moving focus. */
export function NativeCardLoading() {
	const content = useContext(Content);
	if (!content) return null;
	return <section className="my-3" aria-label={content.label} aria-busy="true"><ReadableCard content={content} /></section>;
}

/**
 * If the interactive card does not load, the document stays readable and a compact notice offers Try again. Without
 * a document to show (a classic chat), only the notice shows.
 */
export function NativeCardFailed({ retry }: LoadFailureProps) {
	const content = useContext(Content);
	return <section className="my-3" aria-label={content?.label}>
		{content && <ReadableCard content={content} />}
		<LoadFailedNotice retry={retry} className={content ? "mt-2" : undefined} />
	</section>;
}

function ReadableCard({ content }: { content: LoadingContent }) {
	return <Card>
		<h3 className="selectable text-base font-semibold text-fg">{content.title}</h3>
		<div className="selectable mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-sm text-fg-muted">
			{content.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
			{content.options.length > 0 && <ul className="mt-3 space-y-1">{content.options.map(option => <li key={option.id}>
				{option.label}{option.description && <p>{option.description}</p>}
			</li>)}</ul>}
		</div>
	</Card>;
}
