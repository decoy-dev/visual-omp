import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";
import { cn } from "./cn";
import { Spinner } from "./Spinner";
import { disabledNative, focusRing } from "./styles";
import { Tooltip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
export type ButtonSize = "sm" | "md" | "lg";

const base = cn(
	"relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium",
	"transition-[background-color,color,border-color,box-shadow,translate,scale,filter] duration-(--dur-fast) ease-(--ease-out)",
	"enabled:active:scale-[0.98] data-loading:pointer-events-none",
	focusRing,
	disabledNative,
);

const variants: Record<ButtonVariant, string> = {
	// §1.9 primary-button depth: the one allowed inset top highlight.
	primary: cn(
		"bg-accent text-accent-fg shadow-(--shadow-primary)",
		"enabled:hover:-translate-y-px enabled:hover:bg-accent-hover enabled:active:translate-y-0 enabled:active:bg-accent-active",
	),
	secondary: cn(
		"border border-border-strong bg-panel text-fg shadow-(--shadow-card)",
		"enabled:hover:bg-inset enabled:active:bg-selected",
	),
	ghost: "bg-transparent text-fg-muted enabled:hover:bg-hover enabled:hover:text-fg enabled:active:bg-selected",
	// `--fg-inverse` is white in light (per spec) and near-black in dark, where white on `--err` would fail AA.
	danger: "bg-err text-fg-inverse shadow-(--shadow-primary) enabled:hover:bg-err-hover",
	"danger-ghost": "bg-transparent text-err enabled:hover:bg-err-bg",
};

const sizes: Record<ButtonSize, string> = {
	sm: "h-7 gap-1.5 px-3 text-sm",
	md: "h-8 gap-1.5 px-3.5 text-md",
	lg: "h-10 gap-2 px-[18px] text-md font-semibold",
};

const iconSizes: Record<ButtonSize, string> = {
	sm: "[&>svg]:size-3.5",
	md: "[&>svg]:size-4",
	lg: "[&>svg]:size-4",
};

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	/** Leading icon (lucide element). */
	icon?: ReactNode;
	/** Trailing icon, e.g. a chevron. */
	iconRight?: ReactNode;
	/** Swaps the label for a spinner at the same width; clicks are ignored while set. */
	loading?: boolean;
}

export function Button({
	variant = "secondary",
	size = "md",
	icon,
	iconRight,
	loading = false,
	type = "button",
	className,
	children,
	onClick,
	...rest
}: ButtonProps) {
	const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
		if (loading) {
			event.preventDefault();
			return;
		}
		onClick?.(event);
	};
	return (
		<button
			type={type}
			aria-busy={loading || undefined}
			aria-disabled={loading || undefined}
			data-loading={loading ? "" : undefined}
			className={cn(base, variants[variant], sizes[size], className)}
			onClick={handleClick}
			{...rest}
		>
			<span className={cn("inline-flex items-center gap-[inherit]", loading && "invisible")}>
				{icon && <span className={cn("inline-flex shrink-0", iconSizes[size])}>{icon}</span>}
				{children}
				{iconRight && <span className={cn("inline-flex shrink-0", iconSizes[size])}>{iconRight}</span>}
			</span>
			{loading && (
				<span className="absolute inset-0 flex items-center justify-center">
					<Spinner size={size === "sm" ? 12 : 14} tone="current" />
				</span>
			)}
		</button>
	);
}

export type IconButtonSize = "sm" | "md" | "lg";
export type IconButtonVariant = "ghost" | "secondary" | "danger-ghost";

const iconButtonSizes: Record<IconButtonSize, string> = {
	sm: "size-6 [&>svg]:size-3.5",
	md: "size-7 [&>svg]:size-4",
	lg: "size-8 [&>svg]:size-4",
};

export interface IconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children" | "aria-label"> {
	/** Accessible name and tooltip text. */
	label: string;
	/** Shortcut shown in the tooltip, e.g. "⌘R". */
	shortcut?: string;
	/** The icon (lucide element). */
	icon: ReactNode;
	size?: IconButtonSize;
	variant?: IconButtonVariant;
	/** Toggle state; sets aria-pressed and the selected fill. */
	pressed?: boolean;
	tooltipSide?: "top" | "right" | "bottom" | "left";
}

/** Square icon-only button; always tooltipped, aria-label = tooltip text. Sizes 24/28/32. */
export function IconButton({
	label,
	shortcut,
	icon,
	size = "md",
	variant = "ghost",
	pressed,
	tooltipSide,
	type = "button",
	className,
	...rest
}: IconButtonProps) {
	return (
		<Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
			<button
				type={type}
				aria-label={label}
				aria-pressed={pressed}
				className={cn(
					base,
					variants[variant],
					"p-0",
					iconButtonSizes[size],
					pressed && "bg-selected text-fg",
					className,
				)}
				{...rest}
			>
				{icon}
			</button>
		</Tooltip>
	);
}
