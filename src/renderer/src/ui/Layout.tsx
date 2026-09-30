import * as SA from "@radix-ui/react-scroll-area";
import type { ComponentPropsWithRef, ReactNode, Ref } from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";

export interface ScrollAreaProps {
	children: ReactNode;
	/** Which scrollbars to render. */
	orientation?: "vertical" | "horizontal" | "both";
	/** Make the viewport tabbable so keyboard users can scroll it (for non-interactive content). */
	focusable?: boolean;
	viewportRef?: Ref<HTMLDivElement>;
	className?: string;
	viewportClassName?: string;
	"aria-label"?: string;
}

const scrollbarClass =
	"flex touch-none select-none p-0.5 transition-opacity duration-(--dur) data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:w-2.5";

/** Overlay scrollbars that appear on hover/scroll. Give the root a bounded height. */
export function ScrollArea({
	children,
	orientation = "vertical",
	focusable,
	viewportRef,
	className,
	viewportClassName,
	"aria-label": ariaLabel,
}: ScrollAreaProps) {
	return (
		<SA.Root type="hover" scrollHideDelay={600} className={cn("relative overflow-hidden", className)}>
			<SA.Viewport
				ref={viewportRef}
				tabIndex={focusable ? 0 : undefined}
				aria-label={ariaLabel}
				className={cn("size-full rounded-[inherit]", focusable && focusRing, viewportClassName)}
			>
				{children}
			</SA.Viewport>
			{orientation !== "horizontal" && (
				<SA.Scrollbar orientation="vertical" className={scrollbarClass}>
					<SA.Thumb className="relative flex-1 rounded-full bg-border-strong hover:bg-fg-faint" />
				</SA.Scrollbar>
			)}
			{orientation !== "vertical" && (
				<SA.Scrollbar orientation="horizontal" className={scrollbarClass}>
					<SA.Thumb className="relative flex-1 rounded-full bg-border-strong hover:bg-fg-faint" />
				</SA.Scrollbar>
			)}
			<SA.Corner />
		</SA.Root>
	);
}

export interface DividerProps {
	orientation?: "horizontal" | "vertical";
	/** Centered caption for horizontal dividers ("or", section names). */
	label?: ReactNode;
	className?: string;
}

export function Divider({ orientation = "horizontal", label, className }: DividerProps) {
	if (orientation === "vertical") {
		return <div role="separator" aria-orientation="vertical" className={cn("w-px self-stretch bg-border", className)} />;
	}
	if (label) {
		return (
			<div role="separator" className={cn("flex items-center gap-3 text-xs text-fg-faint", className)}>
				<span className="h-px flex-1 bg-border" />
				<span className="shrink-0">{label}</span>
				<span className="h-px flex-1 bg-border" />
			</div>
		);
	}
	return <div role="separator" className={cn("h-px w-full bg-border", className)} />;
}

export type CardRail = "accent" | "blue" | "agent" | "ok" | "warn" | "err" | "info";

export interface CardProps extends ComponentPropsWithRef<"div"> {
	/** Tints the hairline border toward a tone. Pair it with a glyph or text; color is never the only signal. */
	rail?: CardRail;
	/** `--shadow-card`, for cards floating over content. */
	floating?: boolean;
	/** Hover lift (use for clickable cards; put the click target inside). */
	interactive?: boolean;
	/** §5.16 working state: accent border plus a breathing 3px accent halo (running tool cards). */
	working?: boolean;
	padding?: "none" | "sm" | "md";
}

const cardPadding: Record<NonNullable<CardProps["padding"]>, string> = {
	none: "",
	sm: "p-3",
	md: "p-4",
};

/** Hairline tinted toward the tone (replaces the old 2px left rail). Mixed in sRGB so the hue doesn't swing toward the border's. */
const railBorder: Record<CardRail, string> = {
	accent: "border-[color-mix(in_srgb,var(--accent)_35%,var(--border))]",
	agent: "border-[color-mix(in_srgb,var(--accent)_35%,var(--border))]",
	blue: "border-border-strong",
	ok: "border-[color-mix(in_srgb,var(--ok)_35%,var(--border))]",
	warn: "border-[color-mix(in_srgb,var(--warn)_40%,var(--border))]",
	err: "border-[color-mix(in_srgb,var(--err)_40%,var(--border))]",
	info: "border-[color-mix(in_srgb,var(--info)_35%,var(--border))]",
};

export function Card({ rail, floating, interactive, working, padding = "md", className, ...rest }: CardProps) {
	return (
		<div
			data-rail={rail}
			data-floating={floating ? "" : undefined}
			data-interactive={interactive ? "" : undefined}
			className={cn(
				"vo-card rounded-lg border bg-panel text-fg",
				rail ? railBorder[rail] : "border-border",
				interactive && "hover:border-border-strong",
				working && "vo-working",
				cardPadding[padding],
				className,
			)}
			{...rest}
		/>
	);
}
