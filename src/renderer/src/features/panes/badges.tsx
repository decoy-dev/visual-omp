/**
 * Side panel badges for panes that load from their own chunk (Changes, Outputs, Tasks). Badges stay mounted
 * in the pane selector from startup, so they live here, apart from the panes.
 */
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { PaneProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { Badge } from "../../ui";
import { usePaneVisible } from "./common";
import { useGit } from "./git-store";
import { useChatOutputs } from "./outputs-store";
import { backgroundJobs, helpersOf, ompRunning } from "./derive";

/** Changes: `+N −M` for the project's uncommitted changes. */
export function DiffBadge({ projectPath }: PaneProps) {
	const { t } = useTranslation("panes");
	const git = useGit(projectPath);
	const totals = git.status?.totals;
	if (!totals || totals.files === 0) return null;
	return (
		<span className="font-mono text-xs tabular-nums" aria-label={t("diff.badge", { add: totals.additions, del: totals.deletions })}>
			<span className="text-diff-add-text">+{totals.additions}</span> <span className="text-diff-del-text">−{totals.deletions}</span>
		</span>
	);
}

/** Newest output time each chat's Outputs pane has shown, by tab; the first value is the chat's newest result when the tab badge first saw it. */
const useOutputsSeen = create<Record<string, number>>(() => ({}));

/** Outputs: how many outputs arrived (or were made again) since the pane last showed this chat. */
export function OutputsBadge({ session }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const chat = useChatOutputs(session, view);
	const visible = usePaneVisible("outputs");
	const tabId = session?.tabId ?? null;
	const seen = useOutputsSeen(state => (tabId ? state[tabId] : undefined));
	// `latest` covers calls whose made files arrive after this first look, so they aren't counted as new.
	const newest = chat?.latest ?? 0;
	useEffect(() => {
		if (tabId && chat && seen !== newest && (visible || seen === undefined)) useOutputsSeen.setState({ [tabId]: newest });
	}, [tabId, chat, seen, newest, visible]);
	const count = chat && seen !== undefined && !visible ? chat.outputs.filter(output => output.time > seen).length : 0;
	return count > 0 ? <Badge count={count} label={t("outputs.newCount", { count })} /> : null;
}

/** Tab badge: how many helpers and background jobs are running. */
export function TasksBadge({ session }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const entries = view?.guest?.entries;
	const activeTools = view?.guest?.activeTools;
	const backgroundTools = view?.guest?.backgroundTools;
	const agents = view?.guest?.agents;
	const progress = view?.guest?.progress;
	const lifecycle = view?.guest?.lifecycle;
	const running = ompRunning(view);
	const processStartedAt = view?.host?.processStartedAt;
	const count = useMemo(() => {
		const helpers = helpersOf(agents && progress && lifecycle ? { agents, progress, lifecycle } : null, running).filter(helper => helper.status === "running").length;
		const jobs = entries ? backgroundJobs(entries, running, activeTools, backgroundTools, null, undefined, processStartedAt).filter(job => job.state === "running").length : 0;
		return helpers + jobs;
	}, [agents, progress, lifecycle, entries, activeTools, backgroundTools, running, processStartedAt]);
	return count > 0 ? <Badge count={count} label={t("tasks.runningCount", { count })} /> : null;
}
