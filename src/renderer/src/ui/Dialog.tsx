import * as RD from "@radix-ui/react-dialog";
import { Warning, X } from "@phosphor-icons/react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";
import { closeButton } from "./styles";

export const Dialog = RD.Root;
export const DialogTrigger = RD.Trigger;
export const DialogClose = RD.Close;

export type DialogSize = "sm" | "md" | "lg" | "xl";

const dialogWidths: Record<DialogSize, string> = {
	sm: "w-[400px]",
	md: "w-[480px]",
	lg: "w-[560px]",
	xl: "w-[720px]",
};

export interface DialogContentProps extends Omit<ComponentPropsWithRef<typeof RD.Content>, "title"> {
	title: ReactNode;
	description?: ReactNode;
	/** Right-aligned action row, e.g. [Cancel][Action]. */
	footer?: ReactNode;
	size?: DialogSize;
	/** Destructive confirmations: warning glyph, and clicking the scrim does not dismiss. */
	destructive?: boolean;
	/** Hides the corner close button (Esc still cancels). */
	hideClose?: boolean;
}

/**
 * Centered modal. Focus is trapped while open and returned to the trigger on close (Radix).
 * Enters with a spring scale + fade and leaves with a short scale-down (`.vo-dialog` in ui.css); crossfade only under
 * reduced motion.
 */
export function DialogContent({
	title,
	description,
	footer,
	size = "md",
	destructive = false,
	hideClose = false,
	className,
	children,
	onPointerDownOutside,
	...rest
}: DialogContentProps) {
	return (
		<RD.Portal>
			<RD.Overlay className="vo-scrim fixed inset-0 z-(--z-scrim) bg-backdrop" />
			<RD.Content
				{...(description ? null : { "aria-describedby": undefined })}
				onPointerDownOutside={(event) => {
					if (destructive) event.preventDefault();
					onPointerDownOutside?.(event);
				}}
				className={cn(
					"vo-dialog fixed left-1/2 top-1/2 z-(--z-dialog) flex max-h-[calc(100vh-64px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col",
					"rounded-lg border border-border bg-overlay text-fg shadow-(--shadow-overlay) outline-none",
					dialogWidths[size],
					className,
				)}
				{...rest}
			>
				<div className="flex items-start gap-3 px-5 pt-5">
					{destructive && (
						<span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-err-bg text-err">
							<Warning className="size-4" aria-hidden />
						</span>
					)}
					<div className="min-w-0 flex-1">
						<RD.Title className="text-lg font-semibold text-fg">{title}</RD.Title>
						{description && <RD.Description className="mt-1 text-md text-fg-muted">{description}</RD.Description>}
					</div>
					{!hideClose && (
						<RD.Close aria-label="Close" className={cn("-mr-1.5 -mt-1", closeButton)}>
							<X className="size-4" aria-hidden />
						</RD.Close>
					)}
				</div>
				{children && <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 text-md">{children}</div>}
				{footer ? (
					<div className="flex items-center justify-end gap-2 px-5 pb-5 pt-5">{footer}</div>
				) : (
					<div className="pb-5" />
				)}
			</RD.Content>
		</RD.Portal>
	);
}
