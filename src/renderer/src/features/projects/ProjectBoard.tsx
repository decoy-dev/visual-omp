import type { SessionSummary } from "@shared/ipc";
import { sessionTitleText } from "@shared/titleCard";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { type ReactNode, type Ref, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { hostNotices, latestMessageAt } from "../../chat/transcript/notices";
import { ChatStatusMark } from "../../shell/ChatStatusMark";
import { chatActivityKey, chatTitle, elapsed, shortAgo, useNow } from "../../shell/hooks";
import { type ChatTab, controllerFor, useApp } from "../../state/app";
import { liveEntries, liveGuest, type SessionView } from "../../state/session";
import { Button, Chip, cn, Expand, FadeIn, SectionHeader, Skeleton, spring } from "../../ui";
import { SessionTitle } from "../../ui/SessionTitle";
import { runningHelpers } from "../panes/derive";
import { BOARD_GROUPS, type BoardGroup, type BoardRow, projectBoard, recentFold, WaitingTracker } from "./boardModel";

/** Subscribe to every open chat so membership updates even when its row is folded or changes lists. */
function useBoardViews(tabs: readonly ChatTab[]): ReadonlyMap<string, SessionView | null> {
	const store = useMemo(() => {
		const controllers = tabs.map(tab => ({ id: tab.id, controller: controllerFor(tab.id) }));
		let snapshot = new Map<string, SessionView | null>();
		return {
			subscribe(listener: () => void) {
				const stops = controllers.map(({ controller }) => controller?.subscribe(listener));
				return () => { for (const stop of stops) stop?.(); };
			},
			getSnapshot() {
				if (snapshot.size !== controllers.length || controllers.some(({ id, controller }) => snapshot.get(id) !== (controller?.getSnapshot() ?? null))) {
					snapshot = new Map(controllers.map(({ id, controller }) => [id, controller?.getSnapshot() ?? null]));
				}
				return snapshot;
			},
		};
	}, [tabs]);
	return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

function rowTitle(row: BoardRow, fallback: string): string {
	return chatTitle(row.view, row.session?.title ?? row.tab?.title ?? null) ?? row.session?.preview ?? fallback;
}

export function ProjectBoard({ path, sessions, failed = false }: { path: string; sessions: SessionSummary[] | undefined; failed?: boolean }): ReactNode {
	const { t } = useTranslation("projects");
	const tabs = useApp(state => state.tabs);
	const unseen = useApp(state => state.unseenChats);
	const projectTabs = useMemo(() => tabs.filter(tab => tab.projectPath === path), [tabs, path]);
	const views = useBoardViews(projectTabs);
	const groups = useMemo(() => projectBoard(path, projectTabs, sessions, unseen, views), [path, projectTabs, sessions, unseen, views]);
	const id = useId();
	const now = useNow(groups.working.length ? 1000 : 30_000);
	const [all, setAll] = useState(false);
	const [tracker] = useState(() => new WaitingTracker());
	const [announcement, setAnnouncement] = useState<{ id: number; text: string } | null>(null);
	const serial = useRef(0);
	useEffect(() => {
		const entered = tracker.update(groups);
		if (entered.length) setAnnouncement({
			id: ++serial.current,
			text: entered.map(row => t(row.status === "error" ? "overview.board.announceAttention" : "overview.board.announceWaiting", { title: sessionTitleText(rowTitle(row, t("overview.recent.untitled"))) })).join(". "),
		});
	}, [groups, t, tracker]);
	const fold = recentFold(groups.recent, all);
	const hasAttention = groups.waiting.length + groups.working.length + groups.unseen.length > 0;
	const list = (rows: readonly BoardRow[], group: BoardGroup) => (
		<ul className="relative flex flex-col">
			<AnimatePresence initial={false} mode="popLayout">
				{rows.map(row => <ProjectBoardRow key={row.key} row={row} group={group} now={now} />)}
			</AnimatePresence>
		</ul>
	);
	return (
		<LayoutGroup id={id}>
			<div className="sr-only" role="status" aria-atomic="true">
				{announcement && <p key={announcement.id}>{announcement.text}</p>}
			</div>
			<AnimatePresence initial={false} mode="popLayout">
				{BOARD_GROUPS.map(group => {
					const recent = group === "recent";
					const rows = groups[group];
					if (!rows.length && (!recent || (hasAttention && sessions !== undefined))) return null;
					return (
						<FadeIn as="section" key={group} aria-labelledby={`${id}-${group}`} exit={{ opacity: 0 }}>
							<SectionHeader
								id={`${id}-${group}`}
								title={recent ? t("overview.recent.title") : <>{t(`overview.board.${group}`)} <span className="font-normal text-fg-faint">· {rows.length}</span></>}
								className="mb-2"
								actions={recent && fold.hidden > 0 && (
									<Button variant="ghost" size="sm" onClick={() => setAll(value => !value)} aria-expanded={all} aria-controls={`${id}-more`}>
										{all ? t("overview.recent.fewer") : t("overview.recent.all", { count: rows.length })}
									</Button>
								)}
							/>
							{recent && sessions === undefined && (failed ? (
								<p className="py-1 text-md text-fg-muted">{t("overview.board.loadFailed")}</p>
							) : (
								<div className="flex flex-col gap-3 py-1" aria-busy="true">
									{[0, 1, 2].map(row => <Skeleton key={row} height={20} />)}
								</div>
							))}
							{rows.length === 0 ? (!recent || sessions !== undefined) && (
								<p className="py-1 text-md text-fg-muted">{t("overview.recent.empty")}</p>
							) : (
								<div className="-mx-2">
									{list(recent ? fold.first : rows, group)}
									{recent && <Expand open={all} id={`${id}-more`}>{list(fold.rest, group)}</Expand>}
								</div>
							)}
						</FadeIn>
					);
				})}
			</AnimatePresence>
		</LayoutGroup>
	);
}

function ProjectBoardRow({ row, group, now, ref }: { row: BoardRow; group: BoardGroup; now: number; ref?: Ref<HTMLLIElement> }): ReactNode {
	const { t } = useTranslation(["projects", "chat", "tools", "shell"]);
	const { view, session, tab, status, unseen } = row;
	const title = rowTitle(row, t("overview.recent.untitled"));
	const statusLabel = t(`overview.recent.status.${status}`);
	const attention = group === "waiting" || group === "working";
	const recap = useMemo(() => {
		if (group !== "unseen") return undefined;
		const streamingAt = liveGuest(view)?.stream?.timestamp ?? null;
		const lastMessage = latestMessageAt(liveEntries(view) ?? view?.history?.all, streamingAt);
		return hostNotices(view?.host?.notices, lastMessage).find(notice => notice.kind === "recap")?.text;
	}, [group, view]);
	const twoLine = attention || Boolean(recap);
	let sublabel: string | undefined;
	if (group === "waiting") {
		sublabel = view?.guest?.uiRequest?.title || (status === "needsInput" ? view?.host?.programStatus?.msg : view?.error || view?.host?.programStatus?.msg) || (status === "error" ? statusLabel : t("overview.board.waitingFallback"));
	} else if (group === "working" && view) {
		const helpers = runningHelpers(view);
		sublabel = status === "helpersWorking" ? helpers > 1 ? t("overview.board.helpersMore", { count: helpers }) : t("tools:activity.helpers") : t(chatActivityKey(view));
	} else if (group === "unseen") {
		sublabel = recap;
	}
	const time = group === "working" && view?.workingSince != null ? elapsed(now - view.workingSince) : session ? shortAgo(session.updatedAt, now) : undefined;
	const unseenLabel = unseen ? t(`shell:sidebar.unseen.${unseen}`) : undefined;
	const label = [sessionTitleText(title), statusLabel, unseenLabel !== statusLabel ? unseenLabel : undefined, sublabel, view?.readOnly ? t("overview.recent.readOnly") : undefined, time].filter(Boolean).join(". ");
	return (
		<motion.li ref={ref} layout="position" layoutId={row.key} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring.snappy}>
			<button
				type="button"
				onClick={() => tab ? useApp.getState().activateTab(tab.id) : session && useApp.getState().openSession(session)}
				title={session?.preview ?? undefined}
				aria-label={label}
				className={cn("flex w-full gap-3 rounded-md px-2 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover hover:[--mark-overlay:var(--hover)] focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2", twoLine ? "min-h-12 items-start py-1.5" : "h-10 items-center")}
			>
				<ChatStatusMark status={status} label={statusLabel} unseen={unseen} className={twoLine ? "mt-1" : undefined} />
				<div className="min-w-0 flex-1">
					<SessionTitle title={title} className={cn("text-md text-fg", unseen ? "font-semibold" : "font-medium")} />
					{sublabel && <span className="block min-w-0 truncate text-sm text-fg-muted">{sublabel}</span>}
				</div>
				{view?.readOnly && <Chip>{t("overview.recent.readOnly")}</Chip>}
				{time && <span className={cn("shrink-0 font-mono text-xs text-fg-faint", attention && "hidden @min-[28rem]/content:inline")}>{time}</span>}
			</button>
		</motion.li>
	);
}
