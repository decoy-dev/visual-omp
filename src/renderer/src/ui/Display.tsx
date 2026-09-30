import type { ComponentPropsWithRef, CSSProperties, ReactNode } from "react";
import { cn } from "./cn";

export interface SkeletonProps {
	width?: number | string;
	height?: number | string;
	/** `text` = a 12px line, `circle` = avatar, `block` = rounded rect. */
	shape?: "text" | "circle" | "block";
	className?: string;
}

/** Placeholder block with a 1.6s sheen; static fill under reduced motion. Decorative (aria-hidden). */
export function Skeleton({ width, height, shape = "block", className }: SkeletonProps) {
	const style: CSSProperties = { width, height };
	return (
		<span
			aria-hidden
			style={style}
			className={cn(
				"vo-skeleton block",
				shape === "circle" ? "size-8 rounded-full" : shape === "text" ? "h-3 w-full rounded-sm" : "h-16 w-full rounded-sm",
				className,
			)}
		/>
	);
}

/** Keycap. Pass one key per Kbd; group several with a gap. */
export function Kbd({ className, ...rest }: ComponentPropsWithRef<"kbd">) {
	return (
		<kbd
			className={cn(
				"inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-border-strong bg-inset px-1 font-mono text-xs font-medium text-fg-muted shadow-[inset_0_-1px_0_var(--border-strong)]",
				className,
			)}
			{...rest}
		/>
	);
}

export type BracketTone = "faint" | "accent" | "agent";

const bracketTones: Record<BracketTone, string> = {
	faint: "text-fg-faint",
	accent: "text-accent",
	agent: "text-agent",
};

export interface BracketLabelProps {
	children: ReactNode;
	tone?: BracketTone;
	/** Render element; defaults to span. */
	as?: "span" | "h2" | "h3" | "p";
	className?: string;
}

/** `[ LABEL ]` mono uppercase eyebrow; brackets are decorative. */
export function BracketLabel({ children, tone = "faint", as: Tag = "span", className }: BracketLabelProps) {
	return (
		<Tag className={cn("font-mono text-xs uppercase tracking-[0.14em]", bracketTones[tone], className)}>
			<span aria-hidden>[ </span>
			{children}
			<span aria-hidden> ]</span>
		</Tag>
	);
}

export interface EmptyStateProps {
	/** Small icon shown in a tinted tile. */
	icon?: ReactNode;
	/** Larger illustration; replaces the icon tile. */
	art?: ReactNode;
	eyebrow?: ReactNode;
	title: ReactNode;
	body?: ReactNode;
	/** Buttons row. */
	actions?: ReactNode;
	className?: string;
}

export function EmptyState({ icon, art, eyebrow, title, body, actions, className }: EmptyStateProps) {
	return (
		<div className={cn("mx-auto flex max-w-sm flex-col items-center px-6 py-10 text-center", className)}>
			{art ? (
				<div className="mb-4">{art}</div>
			) : (
				icon && (
					<span className="mb-4 inline-flex size-10 items-center justify-center rounded-lg border border-border bg-inset text-fg-muted shadow-(--shadow-card) [&>svg]:size-5">
						{icon}
					</span>
				)
			)}
			{eyebrow && <div className="mb-2">{eyebrow}</div>}
			<h3 className="text-lg font-semibold text-fg">{title}</h3>
			{body && <p className="mt-1.5 text-md text-fg-muted">{body}</p>}
			{actions && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
		</div>
	);
}
