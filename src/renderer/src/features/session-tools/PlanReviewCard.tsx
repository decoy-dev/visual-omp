/**
 * DESIGN §4.9 Plan Review card. Classic chats read the painted overlay and answer with keys.
 * TSP chats project omp's plan overlay and activate its option ids.
 */
import { CaretDown, Check, ClipboardText } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, Chip, cn, Expand, FadeIn, Menu, MenuContent, MenuItem, MenuTrigger, PresenceSwap, Rise, Segmented, toast } from "@/ui";
import { useComposerDrafts } from "../../chat/composer/drafts";
import type { ChatSlotProps } from "../../registry/slots";
import type { SessionController } from "../../state/session";
import { Markdown } from "../../transcript/Markdown";
import { PlanChecklist } from "../panes/PlanChecklist";
import { acknowledgeAuto, setApprovalMode } from "./approval";
import { press, readScreen, reportFailure, waitForScreen } from "./drive";
import { exitPlan, loadPlan } from "./plan";
import { isPlanReview, parsePlanReview, type PlanReviewScreen } from "./screen";
import { screenPoller, useOmpScreen, useSessionView } from "./status";
import { useTspPlanReview } from "./planReviewTsp";
import { usePresentationClaim } from "../../state/tsp/presentation-claims";
import { useApp } from "../../state/app";

type PlanAction = "execute" | "compact" | "keep" | "refine" | "save";

/** Overlay option label prefixes, in omp's order. */
const OPTION_PREFIX: Record<PlanAction, string> = {
	execute: "Approve and execute",
	compact: "Approve and compact context",
	keep: "Approve and keep context",
	refine: "Refine plan",
	save: "Save and quit",
};

/** omp disables "keep context" above this context use (`PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT`). */
const KEEP_CONTEXT_LIMIT = 95;

/** Move the overlay cursor onto the option for `action` and confirm it. */
async function choose(session: SessionController, action: PlanAction): Promise<void> {
	const prefix = OPTION_PREFIX[action];
	for (let step = 0; step < 8; step++) {
		const review = parsePlanReview(await readScreen(session));
		if (!review) throw new Error("Plan Review is no longer open.");
		const target = review.options.findIndex(option => option.label.startsWith(prefix));
		const current = review.options.findIndex(option => option.selected);
		if (target < 0) throw new Error(`omp did not offer "${prefix}".`);
		if (current === target) {
			await press(session, "enter");
			const closed = await waitForScreen(session, lines => !isPlanReview(lines), 6000);
			if (!closed) throw new Error("omp did not accept the choice.");
			void screenPoller(session).refresh();
			return;
		}
		await press(session, current < target ? "down" : "up");
	}
	throw new Error("Could not reach that option in Plan Review.");
}

/** Move the "continue with" slider to `index` (left/right clamp at both ends). */
async function slideTo(session: SessionController, from: number, index: number): Promise<void> {
	const key = index > from ? "right" : "left";
	await press(session, Array.from({ length: Math.abs(index - from) }, () => key).join(" "));
	await waitForScreen(session, lines => parsePlanReview(lines)?.slider?.selected === index, 2000);
	void screenPoller(session).refresh();
}

export function PlanReviewCard({ session }: ChatSlotProps) {
	const { t } = useTranslation("session");
	const view = useSessionView(session);
	const { lines } = useOmpScreen(session);
	const overlays = view.host?.tui?.overlays ?? 0;
	const tsp = useTspPlanReview(session);
	const semantic = view.host?.transport === "tsp";
	const review: PlanReviewScreen | null = semantic ? tsp.review ? {
		options: tsp.review.options,
		slider: tsp.review.slider ? { roles: tsp.review.slider.items.map(item => item.label), selected: tsp.review.slider.selected, model: null } : null,
	} : null : overlays > 0 ? parsePlanReview(lines) : null;
	const [plan, setPlan] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(true);
	const [busy, setBusy] = useState<PlanAction | "discard" | null>(null);
	const [done, setDone] = useState<PlanAction | null>(null);
	const open = review !== null;
	const sessionFile = session.sessionFile;
	const covered = useApp(state => !!state.terminalTabId || !!state.sheet);
	usePresentationClaim(semantic && tsp.review && tsp.snapshot ? {
		hostId: tsp.snapshot.hostId, epoch: tsp.snapshot.epoch, surfaceId: tsp.review.sf, nodeId: tsp.review.id,
	} : null, !covered, true);

	useEffect(() => {
		if (!open || semantic || !sessionFile) return;
		let live = true;
		setDone(null);
		void loadPlan(sessionFile).then(text => live && setPlan(text));
		return () => {
			live = false;
		};
	}, [open, sessionFile, semantic]);
	useEffect(() => { if (semantic && open) setDone(null); }, [semantic, open]);

	// The confirmation row stays until the approved run finishes (or briefly when nothing runs).
	useEffect(() => {
		if (!done || open) return;
		if (view.working) return;
		const timer = window.setTimeout(() => setDone(null), 8000);
		return () => window.clearTimeout(timer);
	}, [done, open, view.working]);

	if (!open && done) {
		return (
			<FadeIn role="status" className="flex items-center gap-2 py-2 text-sm text-fg-muted">
				<Check className="size-4 text-ok" aria-hidden />
				{t(`plan.done.${done}`)}
			</FadeIn>
		);
	}
	if (!review) return null;
	const planText = semantic ? tsp.review?.body ?? null : plan;
	const unavailable = semantic && (tsp.disabled || tsp.review?.committed === true);
	const offered = (action: PlanAction) => !semantic || tsp.review?.options.some(option => option.action === action && !option.disabled) === true;

	const percent = view.guest?.state?.contextUsage?.percent ?? 0;
	const keepOffered = semantic ? tsp.review?.options.some(option => option.action === "keep") === true
		: review.options.some(option => option.label.startsWith(OPTION_PREFIX.keep)) && percent <= KEEP_CONTEXT_LIMIT;
	const title = (semantic ? tsp.review?.title : plan && /^#{1,3}\s+(.+)$/m.exec(plan)?.[1]?.trim()) || t("plan.untitled");
	const slider = review.slider && review.slider.roles.length > 1 ? review.slider : null;

	const act = async (action: PlanAction, before?: () => Promise<void>) => {
		if (busy || unavailable || !offered(action)) return;
		setBusy(action);
		try {
			await before?.();
			if (semantic && tsp.review) await tsp.choose(tsp.review, action);
			else await choose(session, action);
			if (semantic) tsp.assertCurrent();
			if (action === "refine") {
				useComposerDrafts.getState().setDraft(session.tabId, t("plan.refinePrefix"));
				useComposerDrafts.getState().focus(session.tabId);
			}
			setDone(semantic && action === "save" ? null : action);
		} catch (error) {
			reportFailure(error);
		} finally {
			setBusy(null);
		}
	};

	// "Discard plan": close the review, then leave plan mode (the draft file stays in the session folder).
	const discard = async () => {
		if (busy || unavailable) return;
		setBusy("discard");
		try {
			if (semantic && tsp.review) await tsp.choose(tsp.review, "discard");
			else {
				await press(session, "escape");
				await waitForScreen(session, screen => !isPlanReview(screen), 3000);
			}
			if (semantic) tsp.assertCurrent();
			await exitPlan(session);
		} catch (error) {
			reportFailure(error);
		} finally {
			setBusy(null);
		}
	};

	return (
		<Rise as="section" className="my-3" aria-label={t("plan.aria")}>
			<Card padding="none" className="overflow-hidden">
				<div className="flex items-start gap-3 px-4 pt-4">
					<ClipboardText className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
					<div className="min-w-0 flex-1">
						<h3 className="text-base font-semibold text-fg">{title}</h3>
						<p className="mt-1 text-sm text-fg-muted" role={tsp.review?.committed ? "status" : undefined}>{t(tsp.review?.committed ? "plan.applying" : "plan.waiting")}</p>
					</div>
					<Button
						size="sm"
						variant="ghost"
						aria-expanded={expanded}
						iconRight={<CaretDown className={cn("transition-transform duration-(--dur) ease-(--ease-out)", expanded && "rotate-180")} />}
						onClick={() => setExpanded(value => !value)}
					>
						{expanded ? t("plan.hide") : t("plan.show")}
					</Button>
				</div>
				<Expand open={expanded}>
					<div className="mt-3 max-h-96 overflow-y-auto border-t border-border px-4 py-3 text-md">
						{/* The plan file loads after the card appears; fade from the placeholder to the plan. */}
						<PresenceSwap swapKey={planText ? "plan" : "missing"}>
							{planText ? (
								<>
									<PlanChecklist text={planText} className="mb-3" />
									<Markdown text={planText} />
								</>
							) : (
								<p className="text-sm text-fg-muted">{t("plan.missing")}</p>
							)}
						</PresenceSwap>
					</div>
				</Expand>
				<Expand open={slider !== null}>
					{slider && (
						<div className="mx-4 mt-3 flex flex-wrap items-center gap-2">
							<span className="text-sm text-fg-muted">{t("plan.continueWith")}</span>
							<Segmented
								size="sm"
								aria-label={t("plan.continueWith")}
								value={slider.roles[slider.selected] ?? ""}
								options={slider.roles.map(role => ({ value: role, label: role }))}
								disabled={semantic && (!!busy || unavailable)}
								onValueChange={role => {
									const index = slider.roles.indexOf(role);
									if (semantic && tsp.review?.slider) void tsp.send({ ev: "select", sf: tsp.review.sf, id: tsp.review.slider.id, item: tsp.review.slider.items[index]!.id }).catch(reportFailure);
									else void slideTo(session, slider.selected, index);
								}}
							/>
							{slider.model && <span className="text-sm text-fg-faint">{slider.model}</span>}
						</div>
					)}
				</Expand>
				<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
					<Button variant="primary" disabled={semantic && (!!busy || unavailable || !offered("execute"))} loading={busy === "execute"} onClick={() => void act("execute")}>
						{t("plan.actions.execute")}
					</Button>
					<Button variant="secondary" disabled={semantic && (!!busy || unavailable || !offered("compact"))} loading={busy === "compact"} onClick={() => void act("compact")}>
						{t("plan.actions.compact")}
						{percent >= 60 && (
							<Chip tone="ok" className="ml-1 h-5">
								{t("plan.freesContext")}
							</Chip>
						)}
					</Button>
					<Menu>
						<MenuTrigger asChild>
							<Button variant="ghost" disabled={semantic && (!!busy || unavailable)} iconRight={<CaretDown />} loading={busy === "refine" || busy === "keep" || busy === "discard"}>
								{t("plan.actions.more")}
							</Button>
						</MenuTrigger>
						<MenuContent className="w-72">
							<MenuItem disabled={!offered("refine")} onSelect={() => void act("refine")}>{t("plan.actions.refine")}</MenuItem>
							{keepOffered && <MenuItem disabled={!offered("keep")} onSelect={() => void act("keep")}>{t("plan.actions.keep")}</MenuItem>}
							<MenuItem
								disabled={!offered("execute")}
								onSelect={() =>
									void act("execute", async () => {
										acknowledgeAuto();
										await setApprovalMode(session.projectPath, "yolo");
									})
								}
							>
								{t("plan.actions.auto")}
							</MenuItem>
							<MenuItem danger onSelect={() => void discard()}>
								{t("plan.actions.discard")}
							</MenuItem>
						</MenuContent>
					</Menu>
					<span className="flex-1" />
					<Button variant="ghost" disabled={semantic && (!!busy || unavailable || !offered("save"))} loading={busy === "save"} onClick={() => void act("save")}>
						{t("plan.actions.save")}
					</Button>
				</div>
			</Card>
		</Rise>
	);
}
