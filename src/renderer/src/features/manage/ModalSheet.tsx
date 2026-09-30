/**
 * Centered modal sheet (DESIGN §4.12–4.14: "Modal sheet 880×640"): header with title, subtitle and
 * actions, then a full-height body the caller lays out itself (nav + content, list + editor).
 * The ui `Sheet` is edge-docked and `DialogContent` pads its body, so neither fits these screens.
 * Inside the sheet host it follows `useSheetPresence`, so closing plays the dialog's exit before unmounting.
 */
import * as RD from "@radix-ui/react-dialog";
import { X } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useSheetPresence } from "@/registry/sheetPresence";
import { cn } from "@/ui";
import { closeButton } from "@/ui/styles";

export interface ModalSheetProps {
	/** Called for Esc, the close button and scrim clicks. */
	onClose(): void;
	width: number;
	height: number;
	title: ReactNode;
	/** Plain-language subtitle under the title. */
	description?: ReactNode;
	/** Header actions left of the close button. */
	actions?: ReactNode;
	closeLabel: string;
	children: ReactNode;
	className?: string;
}

export function ModalSheet({ onClose, width, height, title, description, actions, closeLabel, children, className }: ModalSheetProps) {
	const presence = useSheetPresence();
	return (
		<RD.Root open={presence.open} onOpenChange={open => !open && onClose()}>
			<RD.Portal>
				<RD.Overlay className="vo-scrim fixed inset-0 z-(--z-scrim) bg-backdrop" />
				<RD.Content
					onCloseAutoFocus={presence.exited}
					{...(description ? null : { "aria-describedby": undefined })}
					style={{ width, height }}
					className={cn(
						"vo-dialog fixed left-1/2 top-1/2 z-(--z-sheet) flex max-h-[calc(100vh-64px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden",
						"rounded-lg border border-border bg-overlay text-fg shadow-(--shadow-overlay) outline-none",
						className,
					)}
				>
					<header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border py-2 pl-5 pr-3">
						<div className="min-w-0 flex-1">
							<RD.Title className="flex items-center gap-2 truncate text-lg font-semibold text-fg">{title}</RD.Title>
							{description && <RD.Description className="truncate text-sm text-fg-muted">{description}</RD.Description>}
						</div>
						{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
						<RD.Close aria-label={closeLabel} className={closeButton}>
							<X className="size-4" aria-hidden />
						</RD.Close>
					</header>
					<div className="flex min-h-0 flex-1">{children}</div>
				</RD.Content>
			</RD.Portal>
		</RD.Root>
	);
}
