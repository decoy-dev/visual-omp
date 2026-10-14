import type { ReactNode } from "react";
import { cn } from "./cn";
import { focusRingInset } from "./styles";

export interface ShareItem {
	id: string;
	label: ReactNode;
	/** Full name on hover, when `label` may be shortened (a folder name for a path). */
	title?: string;
	value: number;
	/** `value` as text, such as "$21.40". */
	display: ReactNode;
	/** A remainder row ("3 other projects"): neutral dot, never selectable. */
	rest?: boolean;
}

export interface ShareBarProps {
	items: readonly ShareItem[];
	/** Accessible name for the list. */
	label: string;
	/** Makes each non-remainder row a button, such as "show this project's chats". */
	onSelect?(id: string): void;
	/** Accessible name of a row's button. */
	selectLabel?(item: ShareItem): string;
	className?: string;
}

/**
 * Categorical dots for breakdown rows (DESIGN §4.18): the accent and three syntax hues, then the same
 * hues at 70% chroma. Dots only, never fills, so the one-accent rule holds for the bars.
 */
const DOTS = ["var(--accent)", "var(--syn-function)", "var(--syn-number)", "var(--syn-type)"];

function dotColor(index: number): string {
	const color = DOTS[index % DOTS.length];
	return index < DOTS.length ? color : `oklch(from ${color} l calc(c * 0.7) h)`;
}

/**
 * Breakdown rows (DESIGN §4.18): a dot, the name and the value, over a bar whose length is the row's
 * value against the largest one. Rows keep the order given.
 */
export function ShareBar({ items, label, onSelect, selectLabel, className }: ShareBarProps) {
	const max = Math.max(0, ...items.map(item => item.value));
	return (
		<ul aria-label={label} className={cn("flex flex-col", className)}>
			{items.map((item, index) => {
				const body = (
					<>
						<span className="flex min-w-0 items-center gap-2">
							<span
								aria-hidden
								className={cn("size-2 shrink-0 rounded-full", item.rest && "border border-fg-faint")}
								style={item.rest ? undefined : { backgroundColor: dotColor(index) }}
							/>
							<span className={cn("min-w-0 flex-1 truncate text-left", item.rest ? "text-fg-muted" : "text-fg")} title={item.title}>
								{item.label}
							</span>
							<span className="shrink-0 font-mono text-sm tabular-nums text-fg">{item.display}</span>
						</span>
						<span aria-hidden className="relative block h-1.5 overflow-hidden rounded-full bg-inset">
							<span
								className={cn(
									"absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--dur-spring-gentle) ease-(--ease-spring)",
									item.rest ? "bg-border-strong" : "bg-fg/30",
								)}
								style={{ width: `${max > 0 ? (item.value / max) * 100 : 0}%` }}
							/>
						</span>
					</>
				);
				return (
					<li key={item.id}>
						{onSelect && !item.rest ? (
							<button
								type="button"
								aria-label={selectLabel?.(item)}
								onClick={() => onSelect(item.id)}
								className={cn(
									"flex w-full flex-col gap-2 rounded-sm px-row py-2 text-md transition-colors duration-(--dur-fast) hover:bg-hover",
									focusRingInset,
								)}
							>
								{body}
							</button>
						) : (
							<div className="flex flex-col gap-2 px-row py-2 text-md">{body}</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}
