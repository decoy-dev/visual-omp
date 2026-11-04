/**
 * Right-dock panes (DESIGN §3.7): Changes (id `diff`) · Files · Preview · Outputs · Tasks · Plan · Terminal.
 * Each pane loads from its own chunk; their badges load with the app (`./badges`). The Terminal pane loads
 * xterm.js only for its terminal view.
 */
import { ChatCircle, ClipboardText, GitDiff, type Icon, Images, ListChecks, MonitorPlay, TerminalWindow, TreeStructure } from "@phosphor-icons/react";
import { registerCommand } from "../../registry/commands";
import { lazyView } from "../../registry/lazy";
import { chatSlots, panes } from "../../registry/slots";
import { useApp } from "../../state/app";
import { Skeleton } from "../../ui";
import { DiffBadge, OutputsBadge, PlanBadge, TasksBadge, TerminalBadge } from "./badges";
import { HelperStrip } from "./HelperStrip";
import { newShell } from "./terminal";
import { BtwPane } from "../btw/BtwPane";

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
panes.register({ id: "preview", order: 30, title: "panes:names.preview", icon: MonitorPlay, component: lazyView(() => import("./PreviewPane").then(m => m.PreviewPane), PaneLoading) });
panes.register({
	id: "outputs",
	order: 35,
	title: "panes:names.outputs",
	icon: Images,
	component: lazyView(() => import("./OutputsPane").then(m => m.OutputsPane), PaneLoading),
	badge: OutputsBadge,
});
panes.register({ id: "tasks", order: 40, title: "panes:names.tasks", icon: ListChecks, component: lazyView(() => import("./TasksPane").then(module => module.TasksPane), PaneLoading), badge: TasksBadge });
// Running helpers pinned at the bottom of the chat, above the working line (DESIGN §3.5).
chatSlots.register({ id: "pinned-helpers", placement: "aboveComposer", order: 10, component: HelperStrip });
panes.register({ id: "plan", order: 50, title: "panes:names.plan", icon: ClipboardText, component: lazyView(() => import("./PlanPane").then(m => m.PlanPane), PaneLoading), badge: PlanBadge });
panes.register({
	id: "btw", order: 55, title: "panes:names.btw", icon: ChatCircle,
	component: BtwPane,
	when: session => session?.getSnapshot().host?.transport === "tsp",
});
panes.register({ id: "terminal", order: 60, title: "panes:names.terminal", icon: TerminalWindow, component: lazyView(() => import("./TerminalPane").then(m => m.TerminalPane), PaneLoading), badge: TerminalBadge });

const SHOW: ReadonlyArray<{ id: string; icon: Icon }> = [
	{ id: "diff", icon: GitDiff },
	{ id: "files", icon: TreeStructure },
	{ id: "preview", icon: MonitorPlay },
	{ id: "outputs", icon: Images },
	{ id: "tasks", icon: ListChecks },
	{ id: "plan", icon: ClipboardText },
	{ id: "btw", icon: ChatCircle },
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
		when: ctx => id !== "btw" || ctx.session?.getSnapshot().host?.transport === "tsp",
		run: ctx => useApp.getState().showPane(id, ctx.session?.tabId),
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
		if (ctx.projectPath) void newShell(ctx.projectPath, ctx.session?.tabId);
	},
});
