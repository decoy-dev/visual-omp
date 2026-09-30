import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { panes } from "../registry/slots";
import { focusedController, useApp } from "../state/app";
import { cn, IconButton } from "../ui";
import { useSessionView } from "./hooks";

/** Right dock with registered panes: Diff · Files · Preview · Tasks · Plan · Terminal (DESIGN §3.7). */
export function Dock({ width }: { width: number }): ReactNode {
	const { t } = useTranslation("shell");
	const list = panes.use();
	const paneId = useApp(state => state.dockPane);
	const projectPath = useApp(state => state.activeProject);
	// Subscribe so panes re-render when the focused chat changes.
	useApp(state => state.activeTabId + (state.splitTabId ?? "") + state.focusedSplit + state.view);
	const session = focusedController();
	useSessionView(session);
	const pane = list.find(entry => entry.id === paneId) ?? list[0];

	return (
		<aside aria-label={t("dock.label")} data-tour="dock" style={{ width }} className="flex shrink-0 flex-col border-l border-border bg-panel">
			<div className="flex h-8 shrink-0 items-end gap-1 border-b border-border px-2">
				<div role="tablist" aria-label={t("dock.label")} className="flex min-w-0 flex-1 items-end gap-0.5 overflow-hidden">
					{list.map(entry => {
						const active = entry.id === pane?.id;
						const Icon = entry.icon;
						return (
							<button
								key={entry.id}
								type="button"
								role="tab"
								aria-selected={active}
								onClick={() => useApp.getState().showPane(entry.id)}
								className={cn(
									"relative flex h-7 items-center gap-1.5 rounded-t-md px-2 text-md font-medium outline-none focus-visible:outline-2 focus-visible:outline-ring",
									active ? "text-accent after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent" : "text-fg-muted hover:text-fg",
								)}
							>
								<Icon className="size-3.5" aria-hidden />
								{t(entry.title, { ns: entry.title.includes(":") ? undefined : "panes" })}
								{entry.badge && <entry.badge session={session} projectPath={projectPath} />}
							</button>
						);
					})}
				</div>
				<IconButton className="mb-0.5" label={t("dock.close")} shortcut="⌥⌘B" icon={<X />} size="sm" onClick={() => useApp.getState().toggleDock(false)} />
			</div>
			<div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
				{pane ? <pane.component session={session} projectPath={projectPath} /> : <p className="p-6 text-md text-fg-faint">{t("dock.empty")}</p>}
			</div>
		</aside>
	);
}
