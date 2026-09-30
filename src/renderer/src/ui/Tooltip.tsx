import * as RT from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

export interface TooltipProviderProps {
	children: ReactNode;
	/** Hover intent before showing; 400ms per spec. */
	delayDuration?: number;
}

/** Mount once near the root; every Tooltip/IconButton below shares its hover-intent timing. */
export function TooltipProvider({ children, delayDuration = 400 }: TooltipProviderProps) {
	return (
		<RT.Provider delayDuration={delayDuration} skipDelayDuration={200}>
			{children}
		</RT.Provider>
	);
}

export interface TooltipProps {
	/** Tooltip text. */
	content: ReactNode;
	/** Keyboard shortcut rendered after the text in mono faint, e.g. "⌘R". */
	shortcut?: string;
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
	/** A single focusable element; it becomes the trigger. */
	children: ReactElement;
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	className?: string;
}

export function Tooltip({ content, shortcut, side = "top", align = "center", children, className, ...root }: TooltipProps) {
	return (
		<RT.Root {...root}>
			<RT.Trigger
				asChild
				onFocus={(event) => {
					// Programmatic focus (dialog/sheet auto-focus, focus return) must not pop the tooltip; keyboard focus does.
					if (!event.currentTarget.matches(":focus-visible")) event.preventDefault();
				}}
			>
				{children}
			</RT.Trigger>
			<RT.Portal>
				<RT.Content
					side={side}
					align={align}
					sideOffset={8}
					collisionPadding={8}
					className={cn(
						"vo-pop z-(--z-tooltip) flex max-w-72 select-none items-center gap-1.5 rounded-sm border border-border bg-raised p-1.5 text-xs leading-none font-medium text-fg shadow-(--shadow-pop)",
						className,
					)}
				>
					<span>{content}</span>
					{shortcut && (
						<>
							<span aria-hidden className="text-fg-faint">
								·
							</span>
							<kbd className="font-mono text-fg-faint">{shortcut}</kbd>
						</>
					)}
				</RT.Content>
			</RT.Portal>
		</RT.Root>
	);
}
