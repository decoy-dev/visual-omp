import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark";
import { cn } from "./cn";

// `Mark` is the name existing callers import; the geometry lives only in BrandMark.tsx.
export { BrandMark, BrandMark as Mark, type BrandMarkProps, type BrandMarkProps as MarkProps } from "./BrandMark";

export interface WordmarkProps {
	/** Show the Mark before the text. */
	withMark?: boolean;
	size?: "sm" | "md" | "lg";
	className?: string;
}

/** Mark box ≈ 1.3× the text size with an 8px gap, as in the C1 title-bar lockup (18px mark beside 14px text). */
const wordmarkSizes: Record<NonNullable<WordmarkProps["size"]>, { text: string; mark: number }> = {
	sm: { text: "text-base leading-5", mark: 18 },
	md: { text: "text-lg", mark: 21 },
	lg: { text: "text-2xl", mark: 31 },
};

/** "visual-omp" in Geist Mono 600, tracked slightly tight, optionally led by the mark. */
export function Wordmark({ withMark = false, size = "md", className }: WordmarkProps) {
	const s = wordmarkSizes[size];
	return (
		<span
			className={cn(
				"inline-flex items-center gap-2 font-mono font-semibold tracking-[-0.02em] text-fg",
				s.text,
				className,
			)}
		>
			{withMark && <BrandMark size={s.mark} />}
			<span>visual-omp</span>
		</span>
	);
}

export interface PulseDotProps {
	/** Screen-reader text; omit when visible text already says it (e.g. inside WorkingIndicator). */
	label?: string;
	className?: string;
}

/** §5.16 compact working form: 8px accent dot pulsing 1 → 0.45 → 1 (frozen at 60% under reduced motion). */
export function PulseDot({ label, className }: PulseDotProps) {
	return (
		<span className={cn("relative inline-flex size-2 shrink-0", className)}>
			<span aria-hidden className="vo-pulse-dot size-2 rounded-full" />
			{label && <span className="sr-only">{label}</span>}
		</span>
	);
}

export interface WorkingIndicatorProps {
	/** Always-visible status text ("Working… 14s", "Running tests"); motion is never the only signal. */
	label: ReactNode;
	size?: "sm" | "md";
	className?: string;
}

/**
 * omp-is-working row: pulse dot + label. Not a live region (elapsed-time labels would chatter);
 * announce state changes where they happen.
 */
export function WorkingIndicator({ label, size = "md", className }: WorkingIndicatorProps) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-2 font-medium text-fg-muted",
				size === "sm" ? "text-sm" : "text-md",
				className,
			)}
		>
			<PulseDot />
			<span>{label}</span>
		</span>
	);
}

export interface GlowBorderProps {
	/** Turns the working border + breathing accent halo on (fades in/out). */
	active: boolean;
	/** Must match the wrapped element's radius, e.g. "rounded-xl". */
	radiusClassName?: string;
	children: ReactNode;
	className?: string;
}

/**
 * §5.16 working state for any child (composer, inputs): a 1px accent line drawn over the child's own 1px border,
 * plus a 3px accent halo that breathes. Reduced motion: static halo. For plain cards prefer `Card working`.
 */
export function GlowBorder({ active, radiusClassName = "rounded-lg", children, className }: GlowBorderProps) {
	return (
		<div data-active={active ? "" : undefined} className={cn("vo-glow", radiusClassName, className)}>
			{children}
		</div>
	);
}
