/**
 * Running helpers above the composer (DESIGN §3.5, §4.6). One horizontal row of compact cards retains identity,
 * duration and independent Stop controls. Width determines how many cards fit, up to four. Overflow and the
 * trailing See all tasks action open Tasks. Conversation entry and transcript pinning keep their existing rules.
 * Focus follows a departing card, then overflow, then See all tasks, then the message box.
 * Expand and listRowMotion preserve open, close and reduced-motion behavior.
 */
import { Square } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { fmtDuration } from "../../collab/lib/format";
import type { ChatSlotProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { RunningTime } from "../../tool-render/tools/task";
import { cn, Expand, IconButton, useMotionReduced, useUpdateCue } from "../../ui";
import { listRowMotion } from "./common";
import type { Helper } from "./derive";
import { usePinnedHelpers } from "./pinnedHelpers";
import { openHelper } from "./helperFocus";
import { HelperIdentity } from "./HelperIdentity";

/** Forward the row ref so popLayout removes departing cards from the width budget while they fade. */
function PinnedRow({ helper, session, onOpen, layoutKey, reduced, ref }: { helper: Helper; session: SessionController; onOpen(helper: Helper): void; layoutKey: string; reduced: boolean; ref?: Ref<HTMLLIElement> }): ReactNode {
	const { t } = useTranslation("panes");
	const cardRef = useRef<HTMLLIElement | null>(null);
	useImperativeHandle(ref, () => cardRef.current!, []);
	useUpdateCue(cardRef, JSON.stringify([helper.toolCount, helper.activity, helper.currentTool]));
	const time =
		helper.durationMs === null ? null : helper.durationAt !== null ? <RunningTime durationMs={helper.durationMs} since={helper.durationAt} /> : fmtDuration(helper.durationMs);
	const text = <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{helper.name}</span>;
	return (
		<motion.li ref={cardRef} layout={reduced ? false : "position"} layoutDependency={layoutKey} {...listRowMotion} data-helper-id={helper.id} className="flex h-10 min-w-[9.5rem] flex-1 items-center gap-2 rounded-lg border border-border bg-panel px-2">
			<HelperIdentity helper={helper} compact />
			<span className="sr-only">{t("tasks.helperStatus.running")}</span>
			{helper.hasTranscript || helper.messageable ? (
				<button
					type="button"
					title={helper.activity || undefined}
					aria-label={`${t("tasks.transcript", { name: helper.name })}, ${t("tasks.helperStatus.running")}`}
					onClick={() => onOpen(helper)}
					className="-ml-1.5 flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md px-1.5 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
				>
					{text}
				</button>
			) : (
				<div title={helper.activity || undefined} className="flex min-w-0 flex-1 items-center gap-2">
					{text}
				</div>
			)}
			{time !== null && <span className="shrink-0 font-mono text-xs tabular-nums text-fg-faint">{time}</span>}
			<IconButton
				size="sm"
				variant="danger-ghost"
				data-helper-stop
				label={t("tasks.stop", { name: helper.name })}
				icon={<Square weight="fill" />}
				onClick={() => session.agentCommand("kill", helper.id)}
			/>
		</motion.li>
	);
}

/** Reserve the trailing actions, then fit readable cards in the remaining width. Values scale with text size. */
export function helperCardFit(width: number, actionsWidth: number, total: number, rem: number, overflowWidth: number): number {
	const withoutOverflow = Math.min(4, total, Math.max(0, Math.floor((width - actionsWidth) / (rem * 10))));
	return withoutOverflow >= total ? withoutOverflow : Math.min(4, total, Math.max(0, Math.floor((width - actionsWidth - overflowWidth - rem * 0.5) / (rem * 10))));
}

export function HelperStrip({ session }: ChatSlotProps): ReactNode {
	const { t } = useTranslation("panes");
	const reduced = useMotionReduced();
	const view = useSessionView(session);
	const pinned = usePinnedHelpers(view);
	const listRef = useRef<HTMLUListElement | null>(null);
	const allRef = useRef<HTMLButtonElement | null>(null);
	const moreRef = useRef<HTMLButtonElement | null>(null);
	const [fit, setFit] = useState(4);
	const shown = pinned.all.slice(0, fit);
	const more = pinned.all.length - shown.length;
	useLayoutEffect(() => {
		const list = listRef.current;
		const action = allRef.current;
		const overflow = moreRef.current;
		if (!list || !action) return;
		const measure = () => {
			const width = list.getBoundingClientRect().width;
			if (width <= 0) return;
			setFit(helperCardFit(width, action.getBoundingClientRect().width, pinned.all.length, Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16, overflow?.getBoundingClientRect().width ?? 0));
		};
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		observer.observe(action);
		if (overflow) observer.observe(overflow);
		measure();
		return () => observer.disconnect();
	}, [pinned.all.length, more > 0]);
	// Keep a keyboard destination when a focused card or trailing action leaves.
	const focusedRow = useRef<{ id: string | null; index: number; action?: "more" | "all" } | null>(null);
	const shownKey = shown.map(helper => helper.id).join("\0");
	const layoutKey = `${shownKey}\0${more > 0}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: focus follows visible structure, not progress reports.
	useEffect(() => {
		const focused = focusedRow.current;
		if (!focused || (focused.id !== null && shown.some(helper => helper.id === focused.id))) return;
		if (focused.action === "more" && more > 0) return;
		if (focused.action === "all" && pinned.all.length > 0) return;
		focusedRow.current = null;
		const active = document.activeElement;
		if (active && active !== document.body && !listRef.current?.contains(active)) return;
		// Prefer the card in its place, then overflow, then the persistent Tasks action.
		const next = focused.id === null ? undefined : shown[Math.min(focused.index, shown.length - 1)];
		const target =
			(next && listRef.current?.querySelector<HTMLElement>(`li[data-helper-id="${CSS.escape(next.id)}"] [data-helper-stop]`)) ??
			(more > 0 ? listRef.current?.querySelector<HTMLElement>("[data-helper-more]") : null) ??
			(pinned.all.length > 0 ? allRef.current : null);
		if (target) target.focus();
		else useComposerDrafts.getState().focus(session.tabId);
	}, [shownKey, more > 0, pinned.all.length > 0]);
	return (
		<>
			<Expand open={pinned.all.length > 0}>
				<div className="mx-auto w-full max-w-(--chat-max) px-6 pb-2">
					<ul
						ref={listRef}
						aria-label={t("work.pinned.label")}
						onFocus={event => {
							const row = event.target.closest<HTMLElement>("li[data-helper-id]");
							const id = row?.dataset.helperId;
							focusedRow.current = id
								? { id, index: shown.findIndex(helper => helper.id === id) }
								: { id: null, index: -1, action: event.target.closest("[data-helper-more]") ? "more" : "all" };
						}}
						onBlur={event => {
							if (!event.currentTarget.contains(event.relatedTarget)) focusedRow.current = null;
						}}
						className="relative flex items-center gap-2"
					>
						<AnimatePresence initial={false} mode="popLayout">
							{shown.map(helper => (
								<PinnedRow key={helper.id} helper={helper} session={session} onOpen={helper => openHelper(session, helper)} layoutKey={layoutKey} reduced={reduced} />
							))}
							{more > 0 && (
								<motion.li key="more" layout={reduced ? false : "position"} layoutDependency={layoutKey} {...listRowMotion} className="flex">
									<button
										ref={moreRef}
										type="button"
										data-helper-more
										aria-label={t("work.pinned.more", { count: more })}
										onClick={() => useApp.getState().showPane("tasks", session.tabId)}
										className={cn(
											"h-8 shrink-0 rounded-md px-2 text-sm text-fg-muted outline-none transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg",
											"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
										)}
									>
										+{more}
									</button>
								</motion.li>
							)}
						</AnimatePresence>
						<li className="ml-auto shrink-0">
							<button ref={allRef} type="button" data-helper-all onClick={() => useApp.getState().showPane("tasks", session.tabId)} className="h-8 rounded-md px-2 text-sm text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring">
								{t("work.pinned.all")}
							</button>
						</li>
					</ul>
				</div>
			</Expand>
		</>
	);
}
