/** Right-dock panes (DESIGN §3.7): Diff · Files · Preview · Tasks · Plan · Terminal. */
import { ClipboardList, FileDiff, FolderTree, ListChecks, MonitorPlay, SquareTerminal, TerminalSquare } from "lucide-react";
import { registerCommand } from "../../registry/commands";
import { panes } from "../../registry/slots";
import { useApp } from "../../state/app";
import { DiffBadge, DiffPane } from "./DiffPane";
import { FilesPane } from "./FilesPane";
import { PlanBadge, PlanPane } from "./PlanPane";
import { PreviewPane } from "./PreviewPane";
import { TasksBadge, TasksPane } from "./TasksPane";
import { TerminalBadge, TerminalPane } from "./TerminalPane";
import { newShell } from "./terminal";

panes.register({ id: "diff", order: 10, title: "panes:tabs.diff", icon: FileDiff, component: DiffPane, badge: DiffBadge });
panes.register({ id: "files", order: 20, title: "panes:tabs.files", icon: FolderTree, component: FilesPane });
panes.register({ id: "preview", order: 30, title: "panes:tabs.preview", icon: MonitorPlay, component: PreviewPane });
panes.register({ id: "tasks", order: 40, title: "panes:tabs.tasks", icon: ListChecks, component: TasksPane, badge: TasksBadge });
panes.register({ id: "plan", order: 50, title: "panes:tabs.plan", icon: ClipboardList, component: PlanPane, badge: PlanBadge });
panes.register({ id: "terminal", order: 60, title: "panes:tabs.terminal", icon: SquareTerminal, component: TerminalPane, badge: TerminalBadge });

const SHOW: ReadonlyArray<{ id: string; icon: typeof FileDiff }> = [
	{ id: "diff", icon: FileDiff },
	{ id: "files", icon: FolderTree },
	{ id: "preview", icon: MonitorPlay },
	{ id: "tasks", icon: ListChecks },
	{ id: "plan", icon: ClipboardList },
	{ id: "terminal", icon: SquareTerminal },
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
	icon: TerminalSquare,
	when: ctx => ctx.projectPath !== null,
	run: ctx => {
		if (ctx.projectPath) void newShell(ctx.projectPath);
	},
});
