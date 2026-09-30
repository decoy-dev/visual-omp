import { X } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { panes } from "../registry/slots";
import { focusedController, useApp } from "../state/app";
import { cn, IconButton, PresenceSwap, spring } from "../ui";
import { moveTabFocus, useSessionView } from "./hooks";

/**
 * Right dock with registered panes: Diff · Files · Preview · Tasks · Plan · Terminal (DESIGN §3.7). The pane tabs are a
 * WAI-ARIA tablist with manual activation: arrows, Home and End move focus; Enter or Space shows the pane.
 */
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
	const scope = useId();
	// Pane switches slide toward the tab that was picked: right of the previous one slides in from the right.
	const index = pane ? list.indexOf(pane) : -1;
	const [nav, setNav] = useState<{ index: number; direction: 1 | -1 }>({ index, direction: 1 });
	if (nav.index !== index) setNav({ index, direction: index > nav.index ? 1 : -1 });

	return (
		<aside aria-label={t("dock.label")} data-tour="dock" style={{ width }} className="flex shrink-0 flex-col border-l border-border bg-panel">
			<div className="flex h-8 shrink-0 items-end gap-1 border-b border-border px-2">
				<div role="tablist" aria-label={t("dock.label")} className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]">
					{list.map(entry => {
						const active = entry.id === pane?.id;
						const Icon = entry.icon;
						return (
							<button
								key={entry.id}
								type="button"
								role="tab"
								id={`${scope}-tab-${entry.id}`}
								aria-selected={active}
								aria-controls={active ? `${scope}-panel` : undefined}
								tabIndex={active ? 0 : -1}
								onClick={() => useApp.getState().showPane(entry.id)}
								onKeyDown={moveTabFocus}
								className={cn(
									"relative flex h-7 shrink-0 items-center gap-1.5 rounded-t-md px-2 text-md font-medium whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
									active ? "text-accent" : "text-fg-muted hover:text-fg",
								)}
							>
								{active && (
									<motion.span
										aria-hidden
										layoutId={`${scope}-pane`}
										transition={spring.snappy}
										className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-accent"
									/>
								)}
								<Icon className="size-3.5" aria-hidden />
								{t(entry.title, { ns: entry.title.includes(":") ? undefined : "panes" })}
								{entry.badge && <entry.badge session={session} projectPath={projectPath} />}
							</button>
						);
					})}
				</div>
				<IconButton className="mb-0.5" label={t("dock.close")} shortcut="⌥⌘B" icon={<X />} size="sm" onClick={() => useApp.getState().toggleDock(false)} />
			</div>
			<div
				role="tabpanel"
				id={`${scope}-panel`}
				aria-labelledby={pane ? `${scope}-tab-${pane.id}` : undefined}
				className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
			>
				<PresenceSwap swapKey={pane?.id ?? "none"} variant="slide" direction={nav.direction} className="flex min-h-0 flex-1 flex-col">
					{pane ? <pane.component session={session} projectPath={projectPath} /> : <p className="p-6 text-md text-fg-faint">{t("dock.empty")}</p>}
				</PresenceSwap>
			</div>
		</aside>
	);
}
