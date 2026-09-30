/**
 * DESIGN §4.9 Plan Review card. omp shows Plan Review as a full-screen overlay it does not forward to
 * collab guests, so the app recognises it on the painted screen, draws the plan natively and answers
 * the overlay with keys (options 0..4: execute · compact · keep context · refine · save and quit).
 */
import { Check, ChevronDown, ChevronUp, ClipboardList } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BracketLabel, Button, Card, Chip, Menu, MenuContent, MenuItem, MenuTrigger, Segmented, toast } from "@/ui";
import { useComposerDrafts } from "../../chat/composer/drafts";
import type { ChatSlotProps } from "../../registry/slots";
import type { SessionController } from "../../state/session";
import { Markdown } from "../../transcript/Markdown";
import { acknowledgeAuto, setApprovalMode } from "./approval";
import { press, readScreen, reportFailure, waitForScreen } from "./drive";
import { exitPlan, loadPlan } from "./plan";
import { isPlanReview, parsePlanReview, type PlanReviewScreen } from "./screen";
import { screenPoller, useOmpScreen, useSessionView } from "./status";

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
	const review: PlanReviewScreen | null = overlays > 0 ? parsePlanReview(lines) : null;
	const [plan, setPlan] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(true);
	const [busy, setBusy] = useState<PlanAction | "discard" | null>(null);
	const [done, setDone] = useState<PlanAction | null>(null);
	const open = review !== null;
	const sessionFile = session.sessionFile;

	useEffect(() => {
		if (!open || !sessionFile) return;
		let live = true;
		setDone(null);
		void loadPlan(sessionFile).then(text => live && setPlan(text));
		return () => {
			live = false;
		};
	}, [open, sessionFile]);

	// The confirmation row stays until the approved run finishes (or briefly when nothing runs).
	useEffect(() => {
		if (!done || open) return;
		if (view.working) return;
		const timer = window.setTimeout(() => setDone(null), 8000);
		return () => window.clearTimeout(timer);
	}, [done, open, view.working]);

	if (!open && done) {
		return (
			<div role="status" className="flex items-center gap-2 py-2 text-sm text-fg-muted">
				<Check className="size-4 text-ok" aria-hidden />
				{t(`plan.done.${done}`)}
			</div>
		);
	}
	if (!review) return null;

	const percent = view.guest?.state?.contextUsage?.percent ?? 0;
	const keepOffered = review.options.some(option => option.label.startsWith(OPTION_PREFIX.keep)) && percent <= KEEP_CONTEXT_LIMIT;
	const title = (plan && /^#{1,3}\s+(.+)$/m.exec(plan)?.[1]?.trim()) || t("plan.untitled");

	const act = async (action: PlanAction, before?: () => Promise<void>) => {
		if (busy) return;
		setBusy(action);
		try {
			await before?.();
			await choose(session, action);
			if (action === "refine") {
				useComposerDrafts.getState().setDraft(session.tabId, t("plan.refinePrefix"));
				useComposerDrafts.getState().focus(session.tabId);
			}
			setDone(action);
		} catch (error) {
			reportFailure(error);
		} finally {
			setBusy(null);
		}
	};

	// "Discard plan": close the review, then leave plan mode (the draft file stays in the session folder).
	const discard = async () => {
		if (busy) return;
		setBusy("discard");
		try {
			await press(session, "escape");
			await waitForScreen(session, screen => !isPlanReview(screen), 3000);
			await exitPlan(session);
		} catch (error) {
			reportFailure(error);
		} finally {
			setBusy(null);
		}
	};

	return (
		<Card rail="agent" padding="none" className="my-3 overflow-hidden" aria-label={t("plan.aria")} role="region">
			<div className="flex items-start gap-3 px-4 pt-4">
				<ClipboardList className="mt-0.5 size-4 shrink-0 text-agent" aria-hidden />
				<div className="min-w-0 flex-1">
					<BracketLabel tone="agent">{t("plan.eyebrow")}</BracketLabel>
					<h3 className="mt-1 text-base font-semibold text-fg">{title}</h3>
				</div>
				<Button
					size="sm"
					variant="ghost"
					aria-expanded={expanded}
					iconRight={expanded ? <ChevronUp /> : <ChevronDown />}
					onClick={() => setExpanded(value => !value)}
				>
					{expanded ? t("plan.hide") : t("plan.show")}
				</Button>
			</div>
			{expanded && (
				<div className="mx-4 mt-3 max-h-96 overflow-y-auto rounded-md border border-border bg-inset px-4 py-3 text-md">
					{plan ? <Markdown text={plan} /> : <p className="text-sm text-fg-muted">{t("plan.missing")}</p>}
				</div>
			)}
			{review.slider && review.slider.roles.length > 1 && (
				<div className="mx-4 mt-3 flex flex-wrap items-center gap-2">
					<span className="text-sm text-fg-muted">{t("plan.continueWith")}</span>
					<Segmented
						size="sm"
						aria-label={t("plan.continueWith")}
						value={review.slider.roles[review.slider.selected] ?? ""}
						options={review.slider.roles.map(role => ({ value: role, label: role }))}
						onValueChange={role => {
							const slider = review.slider;
							if (slider) void slideTo(session, slider.selected, slider.roles.indexOf(role));
						}}
					/>
					{review.slider.model && <span className="text-sm text-fg-faint">{review.slider.model}</span>}
				</div>
			)}
			<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
				<Button variant="primary" loading={busy === "execute"} onClick={() => void act("execute")}>
					{t("plan.actions.execute")}
				</Button>
				<Button variant="secondary" loading={busy === "compact"} onClick={() => void act("compact")}>
					{t("plan.actions.compact")}
					{percent >= 60 && (
						<Chip tone="ok" className="ml-1 h-5">
							{t("plan.freesContext")}
						</Chip>
					)}
				</Button>
				<Menu>
					<MenuTrigger asChild>
						<Button variant="ghost" iconRight={<ChevronDown />} loading={busy === "refine" || busy === "keep" || busy === "discard"}>
							{t("plan.actions.more")}
						</Button>
					</MenuTrigger>
					<MenuContent className="w-72">
						<MenuItem onSelect={() => void act("refine")}>{t("plan.actions.refine")}</MenuItem>
						{keepOffered && <MenuItem onSelect={() => void act("keep")}>{t("plan.actions.keep")}</MenuItem>}
						<MenuItem
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
				<Button variant="ghost" loading={busy === "save"} onClick={() => void act("save")}>
					{t("plan.actions.save")}
				</Button>
			</div>
		</Card>
	);
}
