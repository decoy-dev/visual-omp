/**
 * The chat's running helpers, pinned at the bottom of the chat column above the working line (DESIGN §3.5, §4.6), so
 * running work stays in view while the transcript moves on. One dense row each: status mark, name, what it is doing
 * now, tool calls and live run time, and Stop. At most `PINNED_ROWS` rows, then "Show N more in Tasks". A row with a
 * conversation opens it, as the Tasks pane does. While a helper is pinned its card under its task call stays out of
 * the transcript (`unpinnedRuns`); once it stops running it leaves the strip and its card is back in the transcript.
 * Keyboard focus in a row that leaves moves to the row now in its place, else "Show N more", else the message box.
 * The strip opens and closes with `Expand`, rows rise in and fade out (`listRowMotion`), and reduced motion keeps
 * only the fades. The transcript is a flex sibling above it, so its follow keeps the bottom in view as the strip
 * changes height.
 */
import { Square } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { fmtDuration } from "../../collab/lib/format";
import type { ChatSlotProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { RunningTime } from "../../tool-render/tools/task";
import { cn, Expand, IconButton, StatusDot } from "../../ui";
import { listRowMotion } from "./common";
import type { Helper } from "./derive";
import { usePinnedHelpers } from "./pinnedHelpers";
import { TranscriptDialog } from "./TasksPane";

function PinnedRow({ helper, session, onOpen }: { helper: Helper; session: SessionController; onOpen(helper: Helper): void }): ReactNode {
	const { t } = useTranslation("panes");
	const time =
		helper.durationMs === null ? null : helper.durationAt !== null ? <RunningTime durationMs={helper.durationMs} since={helper.durationAt} /> : fmtDuration(helper.durationMs);
	const text = (
		<>
			<span className="min-w-0 max-w-[45%] shrink-0 truncate text-md font-medium text-fg">{helper.name}</span>
			{helper.activity && <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{helper.activity}</span>}
		</>
	);
	return (
		<motion.li layout="position" {...listRowMotion} data-helper-id={helper.id} className="flex h-9 items-center gap-2.5 pr-1.5 pl-3">
			<StatusDot status="agent" glyph label={t("tasks.helperStatus.running")} />
			{helper.hasTranscript ? (
				<button
					type="button"
					title={helper.activity || undefined}
					aria-label={t("tasks.transcript", { name: helper.name })}
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
			{helper.toolCount !== null && helper.toolCount > 0 && (
				<span className="hidden shrink-0 font-mono text-xs tabular-nums text-fg-faint @md:inline">{t("work.helper.tools", { count: helper.toolCount })}</span>
			)}
			{time !== null && <span className="hidden shrink-0 font-mono text-xs tabular-nums text-fg-faint @xs:inline">{time}</span>}
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

export function HelperStrip({ session }: ChatSlotProps): ReactNode {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const pinned = usePinnedHelpers(view);
	const [transcriptOf, setTranscriptOf] = useState<Helper | null>(null);
	const listRef = useRef<HTMLUListElement | null>(null);
	// The row keyboard focus is in, so focus can move on when that helper stops running and its row leaves.
	const focusedRow = useRef<{ id: string; index: number } | null>(null);
	const shownKey = pinned.shown.map(helper => helper.id).join("\0");
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the rows change (`shownKey`).
	useEffect(() => {
		const focused = focusedRow.current;
		if (!focused || pinned.shown.some(helper => helper.id === focused.id)) return;
		focusedRow.current = null;
		const active = document.activeElement;
		if (active && active !== document.body && !listRef.current?.contains(active)) return;
		// The row in its place takes focus (its Stop), else "Show N more", else the message box once the strip closes.
		const next = pinned.shown[Math.min(focused.index, pinned.shown.length - 1)];
		const target =
			(next && listRef.current?.querySelector<HTMLElement>(`li[data-helper-id="${CSS.escape(next.id)}"] [data-helper-stop]`)) ??
			listRef.current?.querySelector<HTMLElement>("[data-helper-more]");
		if (target) target.focus();
		else useComposerDrafts.getState().focus(session.tabId);
	}, [shownKey]);
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
							focusedRow.current = id ? { id, index: pinned.shown.findIndex(helper => helper.id === id) } : null;
						}}
						onBlur={event => {
							if (!event.currentTarget.contains(event.relatedTarget)) focusedRow.current = null;
						}}
						className="@container flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel"
					>
						<AnimatePresence initial={false}>
							{pinned.shown.map(helper => (
								<PinnedRow key={helper.id} helper={helper} session={session} onOpen={setTranscriptOf} />
							))}
							{pinned.more > 0 && (
								<motion.li key="more" layout="position" {...listRowMotion} className="flex">
									<button
										type="button"
										data-helper-more
										onClick={() => useApp.getState().showPane("tasks")}
										className={cn(
											"h-8 flex-1 px-3 text-left text-sm text-fg-muted outline-none transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg",
											"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
										)}
									>
										{t("work.pinned.more", { count: pinned.more })}
									</button>
								</motion.li>
							)}
						</AnimatePresence>
					</ul>
				</div>
			</Expand>
			{transcriptOf && <TranscriptDialog helper={transcriptOf} session={session} onClose={() => setTranscriptOf(null)} />}
		</>
	);
}
