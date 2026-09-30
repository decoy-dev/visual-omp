/**
 * Plan pane (DESIGN §3.7): the chat's plan file (`<session>/local/*plan*.md`, where omp's plan mode
 * writes it) rendered as Markdown, re-read every 2s while the pane is visible. When omp's Plan Review
 * screen is open, a bar offers Approve (the review's first option) or the full set of choices.
 */
import { ClipboardList, ListTree, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PanePlanFile } from "@shared/contracts/panes";
import type { PaneProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { Markdown } from "../../transcript/Markdown";
import { BracketLabel, Button, EmptyState, Spinner, toast } from "../../ui";
import { PaneToolbar, usePaneVisible } from "./common";

const POLL_MS = 2000;
/** Option 0 of omp's Plan Review list (interactive-mode `showPlanReview`). */
const REVIEW_MARKER = "Approve and execute";

/** omp's Plan Review screen is open for this chat (read from the painted TUI screen). */
export function usePlanReviewPending(session: SessionController | null): boolean {
	const view = useSessionView(session);
	const overlays = view?.host?.tui?.overlays ?? 0;
	const hostId = view?.host?.hostId ?? null;
	const [pending, setPending] = useState(false);
	useEffect(() => {
		if (!hostId || overlays === 0) {
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
	}, [hostId, overlays]);
	return pending;
}

function usePlanFile(sessionFile: string | null, visible: boolean): { plan: PanePlanFile | null; loaded: boolean } {
	const [state, setState] = useState<{ file: string | null; plan: PanePlanFile | null; loaded: boolean }>({
		file: null,
		plan: null,
		loaded: false,
	});
	useEffect(() => {
		if (!sessionFile || !visible) return;
		let cancelled = false;
		const read = () =>
			window.vomp
				.invoke("panes:planFile", sessionFile)
				.then(plan => {
					if (cancelled) return;
					setState(previous =>
						previous.file === sessionFile && previous.loaded && previous.plan?.mtime === plan?.mtime && previous.plan?.path === plan?.path
							? previous
							: { file: sessionFile, plan, loaded: true },
					);
				})
				.catch(() => {
					if (!cancelled) setState({ file: sessionFile, plan: null, loaded: true });
				});
		void read();
		const timer = setInterval(read, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [sessionFile, visible]);
	const current = state.file === sessionFile;
	return { plan: current ? state.plan : null, loaded: current && state.loaded };
}

export function PlanPane({ session }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const visible = usePaneVisible("plan");
	const sessionFile = view ? (session?.sessionFile ?? null) : null;
	const { plan, loaded } = usePlanFile(sessionFile, visible);
	const pending = usePlanReviewPending(session);

	const turnOn = () => {
		session?.command("/plan").catch((error: unknown) =>
			toast({ tone: "err", message: t("plan.failed"), description: error instanceof Error ? error.message : String(error) }),
		);
	};

	if (!session) return <EmptyState icon={<ClipboardList />} title={t("plan.noChatTitle")} body={t("plan.noChat")} />;
	if (sessionFile && !loaded) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-muted" role="status">
				<Spinner /> {t("plan.loading")}
			</div>
		);
	}
	if (!plan) {
		return (
			<EmptyState
				icon={<ClipboardList />}
				eyebrow={<BracketLabel>{t("plan.eyebrow")}</BracketLabel>}
				title={t("plan.offTitle")}
				body={t("plan.off")}
				actions={
					<Button size="sm" variant="secondary" disabled={view?.readOnly} onClick={turnOn}>
						{t("plan.turnOn")}
					</Button>
				}
			/>
		);
	}
	const name = plan.path.slice(plan.path.lastIndexOf("/") + 1);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PaneToolbar>
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted" title={plan.path}>
					{name}
				</span>
				<span className="text-xs text-fg-faint">{t("plan.updated", { time: new Date(plan.mtime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</span>
			</PaneToolbar>
			{pending && (
				<div role="status" className="flex shrink-0 items-center gap-2 border-b border-border bg-agent-muted px-3 py-2">
					<span className="min-w-0 flex-1 text-sm font-medium text-fg">{t("plan.waiting")}</span>
					<Button size="sm" variant="ghost" icon={<ListTree />} onClick={() => useApp.getState().openTerminal(session.tabId)} title={t("plan.optionsHint")}>
						{t("plan.options")}
					</Button>
					<Button size="sm" variant="primary" icon={<Play />} onClick={() => void session.keys("enter")} title={t("plan.approveHint")}>
						{t("plan.approve")}
					</Button>
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-md">
				<Markdown text={plan.text} />
			</div>
		</div>
	);
}

/** Tab badge: `!` while omp waits for a decision on the plan. */
export function PlanBadge({ session }: PaneProps) {
	const { t } = useTranslation("panes");
	const pending = usePlanReviewPending(session);
	if (!pending) return null;
	return (
		<span className="inline-flex size-4 items-center justify-center rounded-full bg-agent text-[10px] font-bold text-fg-inverse" title={t("plan.waiting")}>
			<span aria-hidden>!</span>
			<span className="sr-only">{t("plan.waiting")}</span>
		</span>
	);
}
