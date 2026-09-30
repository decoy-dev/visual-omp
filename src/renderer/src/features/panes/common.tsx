/** Hooks and small building blocks shared by the dock panes. */
import { X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { cn, duration, ease, spring } from "../../ui";
import { focusRingInset } from "../../ui/styles";
import { useApp } from "../../state/app";

/** The dock is open on this pane (polling and heavy work only run while visible). */
export function usePaneVisible(id: string): boolean {
	return useApp(state => state.dockOpen && state.dockPane === id);
}

/** Project-relative path with forward slashes (absolute when outside the project). */
export function relativePath(projectPath: string, path: string): string {
	const root = projectPath.replace(/[\\/]+$/, "");
	if (path === root) return ".";
	return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`) ? path.slice(root.length + 1).replace(/\\/g, "/") : path;
}

/**
 * Props for a `motion.li`/`motion.div` row inside `<AnimatePresence initial={false}>` with `layout="position"`:
 * rows present when the list mounts stay at rest, inserted rows rise in, removed rows fade out, and the rest slide
 * into their new places. Reduced motion keeps only the fades.
 */
export const listRowMotion = {
	initial: { opacity: 0, y: 4 },
	animate: { opacity: 1, y: 0 },
	exit: { opacity: 0, transition: { duration: duration.fast, ease: "easeIn" } },
	transition: { layout: spring.snappy, y: spring.gentle, opacity: { duration: duration.base, ease: ease.outQuart } },
} as const;

/** 36px toolbar at the top of a pane. */
export function PaneToolbar({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className={cn("flex h-9 shrink-0 items-center gap-1 border-b border-border bg-panel px-2", className)}>{children}</div>
	);
}

export interface StripTab {
	id: string;
	label: string;
	title?: string;
	icon?: ReactNode;
}

/**
 * Closable tab strip (viewer / terminal tabs). Tabs and their close buttons are siblings, so there
 * is no button-in-button; arrow keys move between tabs (roving focus, WAI-ARIA tabs pattern).
 */
export function TabStrip({
	tabs,
	active,
	onSelect,
	onClose,
	closeLabel,
	label,
	trailing,
}: {
	tabs: readonly StripTab[];
	active: string | null;
	onSelect(id: string): void;
	onClose(id: string): void;
	closeLabel(tab: StripTab): string;
	label: string;
	trailing?: ReactNode;
}) {
	const indicatorId = useId();
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		const index = tabs.findIndex(tab => tab.id === active);
		const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
		if (!next) return;
		event.preventDefault();
		onSelect(next.id);
		event.currentTarget.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next.id)}"]`)?.focus();
	};
	return (
		<div className="flex h-8 shrink-0 items-stretch border-b border-border bg-inset">
			<div role="tablist" aria-label={label} className="flex min-w-0 flex-1 items-stretch overflow-x-auto" onKeyDown={onKeyDown}>
				<AnimatePresence initial={false}>
					{tabs.map(tab => {
						const selected = tab.id === active;
						return (
							<motion.div
								key={tab.id}
								layout="position"
								{...listRowMotion}
								className={cn(
									"group relative flex min-w-0 max-w-44 shrink-0 items-center border-r border-border",
									selected ? "bg-panel text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
								)}
							>
								<button
									type="button"
									role="tab"
									data-tab-id={tab.id}
									aria-selected={selected}
									tabIndex={selected ? 0 : -1}
									title={tab.title ?? tab.label}
									onClick={() => onSelect(tab.id)}
									onAuxClick={event => {
										if (event.button === 1) onClose(tab.id);
									}}
									className={cn(
										"flex h-full min-w-0 items-center gap-1.5 pl-2.5 pr-1 text-sm [&_svg]:size-3.5 [&_svg]:shrink-0",
										focusRingInset,
									)}
								>
									{tab.icon}
									<span className="truncate">{tab.label}</span>
								</button>
								<button
									type="button"
									aria-label={closeLabel(tab)}
									title={closeLabel(tab)}
									onClick={() => onClose(tab.id)}
									className={cn(
										"mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-faint hover:bg-hover hover:text-fg",
										selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
										focusRingInset,
									)}
								>
									<X className="size-3" aria-hidden />
								</button>
								{selected && (
									<motion.span
										aria-hidden
										layoutId={`${indicatorId}-tab`}
										transition={spring.snappy}
										className="absolute inset-x-0 top-0 h-0.5 bg-accent"
									/>
								)}
							</motion.div>
						);
					})}
				</AnimatePresence>
			</div>
			{trailing}
		</div>
	);
}
