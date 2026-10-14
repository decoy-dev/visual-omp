import { CaretDown, CaretLeft, X } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type PaneSpec, panes } from "../registry/slots";
import { focusedController, useApp } from "../state/app";
import { cn, IconButton, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, PresenceSwap } from "../ui";
import { focusRingInset } from "../ui/styles";

function paneTitle(t: (key: string, options?: { ns?: string }) => string, entry: PaneSpec): string {
	return t(entry.title, { ns: entry.title.includes(":") ? undefined : "panes" });
}

/**
 * Right dock with registered panes: Changes · Files · Preview · Outputs · Tasks · Plan · Terminal (DESIGN §3.7). The
 * header names the pane on show; it is a menu button whose list holds every pane with its badge (arrows, Home, End and
 * typeahead move; Enter or Space shows the pane). The other panes' badges stay mounted, hidden, so the trigger can show
 * a dot when one of them has something to say and their "seen" bookkeeping keeps running.
 *
 * Beside the chat it is a floating sheet: rounded on every corner with the pop shadow, on the canvas strip Shell gives it.
 *
 * `expanded`: the window is too narrow for the chat and the panel side by side, so the panel takes the main area and
 * offers "Back to chat" (which shows the chat and keeps the panel open for a wider window) instead of squeezing the chat.
 * It then fills the sheet edge to edge. Shell moves focus to "Back to chat" on entry and back to where it was on the way out.
 */
export function Dock({ width, expanded = false, onEnter }: { width: number; expanded?: boolean; onEnter?: (back: HTMLElement) => void }): ReactNode {
	const { t } = useTranslation("panes");
	const list = panes.use();
	const paneId = useApp(state => state.dockPane);
	const projectPath = useApp(state => state.activeProject);
	// Subscribe so panes re-render when the focused chat changes.
	useApp(state => state.activeTabId + (state.splitTabId ?? "") + state.focusedSplit + state.view);
	const session = focusedController();
	const pane = list.find(entry => entry.id === paneId) ?? list[0];
	const scope = useId();
	// Pane switches slide toward the pane that was picked: one lower in the list slides in from the right.
	const index = pane ? list.indexOf(pane) : -1;
	const [nav, setNav] = useState<{ index: number; direction: 1 | -1 }>({ index, direction: 1 });
	if (nav.index !== index) setNav({ index, direction: index > nav.index ? 1 : -1 });
	const others = list.filter(entry => entry !== pane && entry.badge);
	const title = pane ? paneTitle(t, pane) : null;
	const back = useRef<HTMLButtonElement>(null);
	// Once, when the expanded panel appears (see Shell's useExpandedDockFocus).
	const entered = useRef(onEnter);
	useEffect(() => {
		if (back.current) entered.current?.(back.current);
	}, []);

	return (
		<aside
			aria-label={t("dock.label")}
			data-tour="dock"
			data-dock-expanded={expanded ? "" : undefined}
			style={expanded ? undefined : { width }}
			className={cn(
				"flex flex-col bg-panel",
				expanded ? "min-w-0 flex-1" : "shrink-0 overflow-hidden rounded-lg border border-border shadow-(--shadow-pop)",
			)}
		>
			<div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
				{expanded && (
					<button
						ref={back}
						type="button"
						onClick={() => useApp.getState().returnToChat()}
						className={cn("inline-flex h-7 shrink-0 items-center gap-1 rounded-md pl-1 pr-2 text-md font-medium text-accent hover:bg-hover", focusRingInset)}
					>
						<CaretLeft className="size-4" aria-hidden />
						{t("shell:page.backToChat")}
					</button>
				)}
				{pane && (
					<Menu>
						<MenuTrigger asChild>
							<button
								type="button"
								id={`${scope}-trigger`}
								className={cn(
									"flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-md font-medium text-fg hover:bg-hover data-[state=open]:bg-selected",
									focusRingInset,
								)}
							>
								<pane.icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
								<span id={`${scope}-title`} className="min-w-0 truncate">
									{title}
								</span>
								{pane.badge && (
									<span className="inline-flex shrink-0 items-center">
										<pane.badge session={session} projectPath={projectPath} />
									</span>
								)}
								<span hidden data-other-badges>
									{others.map(entry => entry.badge && <entry.badge key={entry.id} session={session} projectPath={projectPath} />)}
								</span>
								<span className="hidden shrink-0 items-center [[data-other-badges]:has(>*)+&]:inline-flex">
									<span aria-hidden className="size-1.5 rounded-full bg-accent" />
									<span className="sr-only">{t("dock.otherUpdates")}</span>
								</span>
								<CaretDown aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
							</button>
						</MenuTrigger>
						<MenuContent aria-label={t("dock.choose")} className="min-w-60">
							<MenuRadioGroup value={pane.id} onValueChange={id => useApp.getState().showPane(id)}>
								{list.map(entry => (
									<MenuRadioItem key={entry.id} value={entry.id}>
										<span className="flex min-w-0 items-center gap-2">
											<entry.icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
											<span className="min-w-0 truncate">{paneTitle(t, entry)}</span>
											{entry.badge && (
												<span className="ml-auto inline-flex shrink-0 items-center pl-2">
													<entry.badge session={session} projectPath={projectPath} />
												</span>
											)}
										</span>
									</MenuRadioItem>
								))}
							</MenuRadioGroup>
						</MenuContent>
					</Menu>
				)}
				<span className="flex-1" />
				<IconButton label={t("dock.close")} shortcut="⌥⌘B" icon={<X />} size="sm" onClick={() => useApp.getState().toggleDock(false)} />
			</div>
			<div role="region" aria-labelledby={pane ? `${scope}-title` : undefined} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
				<PresenceSwap swapKey={pane?.id ?? "none"} variant="slide" direction={nav.direction} className="flex min-h-0 flex-1 flex-col">
					{pane ? <pane.component session={session} projectPath={projectPath} /> : <p className="p-6 text-md text-fg-faint">{t("dock.empty")}</p>}
				</PresenceSwap>
			</div>
		</aside>
	);
}
