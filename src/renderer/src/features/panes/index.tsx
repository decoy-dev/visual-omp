/**
 * Right-dock panes (DESIGN §3.7): Changes (id `diff`) · Files · Preview · Outputs · Tasks · Plan · Terminal.
 * Changes, Files and Outputs (viewers, syntax colors, media) load from their own chunk; their badges load
 * with the app (`./badges`). The Terminal pane loads xterm.js only for its terminal view.
 */
import { ClipboardText, GitDiff, type Icon, Images, ListChecks, MonitorPlay, TerminalWindow, TreeStructure } from "@phosphor-icons/react";
import { registerCommand } from "../../registry/commands";
import { lazyView } from "../../registry/lazy";
import { panes } from "../../registry/slots";
import { useApp } from "../../state/app";
import { Skeleton } from "../../ui";
import { DiffBadge, OutputsBadge } from "./badges";
import { PlanBadge, PlanPane } from "./PlanPane";
import { PreviewPane } from "./PreviewPane";
import { TasksBadge, TasksPane } from "./TasksPane";
import { TerminalBadge, TerminalPane } from "./TerminalPane";
import { newShell } from "./terminal";

/** Stands in for a pane while its chunk loads. */
function PaneLoading() {
	return (
		<div aria-busy className="flex flex-col gap-2.5 p-3">
			<Skeleton shape="text" className="w-2/3" />
			<Skeleton shape="text" />
			<Skeleton shape="text" className="w-5/6" />
			<Skeleton shape="text" className="w-1/2" />
		</div>
	);
}

panes.register({
	id: "diff",
	order: 10,
	title: "panes:names.diff",
	icon: GitDiff,
	component: lazyView(() => import("./DiffPane").then(m => m.DiffPane), PaneLoading),
	badge: DiffBadge,
});
panes.register({
	id: "files",
	order: 20,
	title: "panes:names.files",
	icon: TreeStructure,
	component: lazyView(() => import("./FilesPane").then(m => m.FilesPane), PaneLoading),
});
panes.register({ id: "preview", order: 30, title: "panes:names.preview", icon: MonitorPlay, component: PreviewPane });
panes.register({
	id: "outputs",
	order: 35,
	title: "panes:names.outputs",
	icon: Images,
	component: lazyView(() => import("./OutputsPane").then(m => m.OutputsPane), PaneLoading),
	badge: OutputsBadge,
});
panes.register({ id: "tasks", order: 40, title: "panes:names.tasks", icon: ListChecks, component: TasksPane, badge: TasksBadge });
panes.register({ id: "plan", order: 50, title: "panes:names.plan", icon: ClipboardText, component: PlanPane, badge: PlanBadge });
panes.register({ id: "terminal", order: 60, title: "panes:names.terminal", icon: TerminalWindow, component: TerminalPane, badge: TerminalBadge });

const SHOW: ReadonlyArray<{ id: string; icon: Icon }> = [
	{ id: "diff", icon: GitDiff },
	{ id: "files", icon: TreeStructure },
	{ id: "preview", icon: MonitorPlay },
	{ id: "outputs", icon: Images },
	{ id: "tasks", icon: ListChecks },
	{ id: "plan", icon: ClipboardText },
	{ id: "terminal", icon: TerminalWindow },
];

for (const { id, icon } of SHOW) {
	registerCommand({
		id: `panes.show.${id}`,
		title: `panes:commands.${id}.title`,
		hint: `panes:commands.${id}.hint`,
		keywords: `panes:commands.${id}.keywords`,
		group: "navigation",
		icon,
		run: () => useApp.getState().showPane(id),
	});
}

registerCommand({
	id: "panes.terminal.new",
	title: "panes:commands.newShell.title",
	hint: "panes:commands.newShell.hint",
	keywords: "panes:commands.newShell.keywords",
	group: "actions",
	icon: TerminalWindow,
	when: ctx => ctx.projectPath !== null,
	run: ctx => {
		if (ctx.projectPath) void newShell(ctx.projectPath);
	},
});
