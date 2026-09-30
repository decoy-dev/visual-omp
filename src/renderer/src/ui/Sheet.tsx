import * as RD from "@radix-ui/react-dialog";
import { X } from "@phosphor-icons/react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";
import { closeButton } from "./styles";

export const Sheet = RD.Root;
export const SheetTrigger = RD.Trigger;
export const SheetClose = RD.Close;

export interface SheetContentProps extends Omit<ComponentPropsWithRef<typeof RD.Content>, "title"> {
	side?: "right" | "bottom";
	/** Right sheets: width (px or CSS length). Default 480. */
	width?: number | string;
	/** Bottom sheets: height (px or CSS length). Default 60vh. */
	height?: number | string;
	title: ReactNode;
	description?: ReactNode;
	/** Header actions left of the close button (icon buttons, segmented…). */
	actions?: ReactNode;
	/** Sticky action row pinned to the bottom. */
	footer?: ReactNode;
	/** Hide the dimming scrim (sheet still traps focus). */
	noScrim?: boolean;
	bodyClassName?: string;
}

/**
 * Docked sheet with header (title · actions · close), scrollable body and sticky footer. Focus trapped/returned by Radix.
 * Slides in from its edge on a spring and slides partway back out on close (`.vo-sheet` in ui.css).
 */
export function SheetContent({
	side = "right",
	width = 480,
	height = "60vh",
	title,
	description,
	actions,
	footer,
	noScrim = false,
	className,
	bodyClassName,
	style,
	children,
	...rest
}: SheetContentProps) {
	const right = side === "right";
	return (
		<RD.Portal>
			{!noScrim && <RD.Overlay className="vo-scrim fixed inset-0 z-(--z-scrim) bg-backdrop" />}
			<RD.Content
				{...(description ? null : { "aria-describedby": undefined })}
				data-side={side}
				style={{ ...(right ? { width } : { height }), ...style }}
				className={cn(
					"vo-sheet fixed z-(--z-sheet) flex max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-lg border border-border bg-overlay text-fg shadow-(--shadow-overlay) outline-none",
					right
						? "bottom-2 right-2 top-[calc(var(--titlebar-h)+8px)]"
						: "bottom-2 left-2 right-2 max-h-[calc(100vh-var(--titlebar-h)-16px)]",
					className,
				)}
				{...rest}
			>
				<header className="flex h-12 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
					<div className="min-w-0 flex-1">
						<RD.Title className="truncate text-base font-semibold text-fg">{title}</RD.Title>
						{description && <RD.Description className="truncate text-sm text-fg-muted">{description}</RD.Description>}
					</div>
					{actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
					<RD.Close aria-label="Close" className={closeButton}>
						<X className="size-4" aria-hidden />
					</RD.Close>
				</header>
				<div className={cn("min-h-0 flex-1 overflow-y-auto p-4 text-md", bodyClassName)}>{children}</div>
				{footer && (
					<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-overlay px-4 py-3">
						{footer}
					</footer>
				)}
			</RD.Content>
		</RD.Portal>
	);
}
