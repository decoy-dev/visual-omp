import { CaretDown, X } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { Menu, MenuContent, MenuTrigger } from "./Menu";
import { focusRing, focusRingInset, pressSmall } from "./styles";

export interface FilterPillProps {
	/** What the filter scopes, such as "Project". */
	label: string;
	/** Leading 14px icon (Phosphor element). */
	icon?: ReactNode;
	/** The chosen value. Set: the pill becomes an applied chip with a clear button. */
	value?: ReactNode;
	/** Clears the filter; shown only while a value is set. */
	onClear?: () => void;
	/** Accessible name for the clear button, such as "Clear project filter". */
	clearLabel?: string;
	align?: "start" | "center" | "end";
	/** Menu rows (MenuItem, MenuRadioGroup…), rendered inside the pill's menu. */
	children: ReactNode;
	className?: string;
}

/**
 * Filter control above the table or chart it scopes (DESIGN §5): a 28px pill that opens a menu of choices. Once a
 * value is chosen it reads as an applied chip ("Project: my-shop") with a trailing clear button.
 */
export function FilterPill({ label, icon, value, onClear, clearLabel, align = "start", children, className }: FilterPillProps) {
	const applied = value !== undefined && value !== null && value !== false;
	return (
		<span
			className={cn(
				"inline-flex h-7 max-w-full shrink-0 items-center rounded-md border text-sm transition-colors duration-(--dur-fast)",
				// Open reads quietly: the hover fill stays (an applied chip gains an accent edge) and the caret turns; the
				// focus ring stays reserved for keyboard focus.
				applied
					? "border-transparent bg-accent-muted text-accent has-[[data-state=open]]:border-accent"
					: "border-border-strong bg-panel text-fg hover:bg-inset has-[[data-state=open]]:bg-inset",
				className,
			)}
		>
			<Menu>
				<MenuTrigger asChild>
					<button
						type="button"
						className={cn(
							"group/pill inline-flex h-full min-w-0 items-center gap-1.5 rounded-md px-2.5 font-medium outline-none",
							applied && onClear && "pr-1",
							focusRingInset,
						)}
					>
						{icon && <span className={cn("inline-flex shrink-0 [&>svg]:size-3.5", applied ? "text-accent" : "text-fg-muted")}>{icon}</span>}
						<span className="shrink-0">{applied ? `${label}:` : label}</span>
						{applied && <span className="min-w-0 truncate font-semibold">{value}</span>}
						{!(applied && onClear) && (
							<CaretDown
								aria-hidden
								className={cn(
									"size-2.5 shrink-0 transition-transform duration-(--dur) ease-(--ease-out-quart) group-data-[state=open]/pill:rotate-180",
									applied ? "text-accent" : "text-fg-muted",
								)}
							/>
						)}
					</button>
				</MenuTrigger>
				<MenuContent align={align}>{children}</MenuContent>
			</Menu>
			{applied && onClear && (
				<button
					type="button"
					aria-label={clearLabel ?? label}
					onClick={onClear}
					className={cn(
						"mr-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-sm opacity-80 transition-[opacity,background-color,scale] duration-(--dur-fast) hover:bg-hover hover:opacity-100",
						pressSmall,
						focusRing,
					)}
				>
					<X aria-hidden className="size-3" />
				</button>
			)}
		</span>
	);
}
