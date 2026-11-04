/** Whether omp waits for a decision on the plan. The Plan pane and its tab badge share it; the badge is always mounted. */
import { useEffect, useState } from "react";
import { useSessionView } from "../../shell/hooks";
import type { SessionController } from "../../state/session";
import { useTspPlanReview } from "../session-tools/planReviewTsp";

/** Option 0 of omp's Plan Review list (interactive-mode `showPlanReview`). */
const REVIEW_MARKER = "Approve and execute";

/** Plan availability follows semantic documents for TSP and the existing painted marker for classic. */
export function usePlanReviewPending(session: SessionController | null): boolean {
	const view = useSessionView(session);
	const overlays = view?.host?.tui?.overlays ?? 0;
	const hostId = view?.host?.hostId ?? null;
	const tsp = view?.host?.transport === "tsp";
	const semantic = useTspPlanReview(session);
	const [pending, setPending] = useState(false);
	useEffect(() => {
		if (!hostId || tsp || overlays === 0) {
			setPending(false);
			return;
		}
		let cancelled = false;
		void window.vomp
			.invoke("host:screen", hostId)
			.then(lines => {
				if (!cancelled) setPending(lines.some(line => line.includes(REVIEW_MARKER)));
			})
			.catch(() => {
				if (!cancelled) setPending(false);
			});
		return () => {
			cancelled = true;
		};
	}, [hostId, overlays, tsp]);
	return tsp ? semantic.review !== null : pending;
}

