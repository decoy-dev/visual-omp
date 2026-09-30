import { type ReactNode, useId } from "react";
import { cn } from "./cn";

/** Circuit V colors (DESIGN §6.1). The mark is a fixed brand asset, identical in both themes. */
const MARK_CYAN = "#22D3EE";
const MARK_BLUE = "#3B82F6";
const MARK_FUCHSIA = "#E879F9";
const OMP_ORANGE = "#F97316";

/** Viewbox cropped to the nodes' outer edges: x 250–774, y 240–796. */
const VIEW_W = 524;
const VIEW_H = 556;

export interface MarkProps {
	/** Rendered height in px; width follows the mark's aspect ratio. */
	size?: number;
	/** Accessible name; omit when decorative (next to visible text). */
	title?: string;
	className?: string;
}

/** The Circuit V: gradient trace, cyan + fuchsia upper nodes, omp-orange apex node. */
export function Mark({ size = 20, title, className }: MarkProps) {
	// useId output contains characters that are awkward inside url(#…); keep it to [A-Za-z0-9_-].
	const gradientId = `vo-mark-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
	return (
		<svg
			width={(size * VIEW_W) / VIEW_H}
			height={size}
			viewBox={`250 240 ${VIEW_W} ${VIEW_H}`}
			fill="none"
			role={title ? "img" : undefined}
			aria-label={title}
			aria-hidden={title ? undefined : true}
			className={cn("shrink-0", className)}
		>
			<defs>
				<linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stopColor={MARK_CYAN} />
					<stop offset="0.5" stopColor={MARK_BLUE} />
					<stop offset="1" stopColor={MARK_FUCHSIA} />
				</linearGradient>
			</defs>
			<path
				d="M302 292 L512 732 L722 292"
				stroke={`url(#${gradientId})`}
				strokeWidth="76"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle cx="302" cy="292" r="52" fill={MARK_CYAN} />
			<circle cx="722" cy="292" r="52" fill={MARK_FUCHSIA} />
			<circle cx="512" cy="732" r="64" fill={OMP_ORANGE} />
		</svg>
	);
}

export interface WordmarkProps {
	/** Show the Mark before the text. */
	withMark?: boolean;
	size?: "sm" | "md" | "lg";
	/** Blink the cursor (1.1s steps). Only for the README hero / about screen; static everywhere else. */
	blink?: boolean;
	className?: string;
}

const wordmarkSizes: Record<NonNullable<WordmarkProps["size"]>, { text: string; mark: number }> = {
	sm: { text: "text-md", mark: 14 },
	md: { text: "text-lg", mark: 18 },
	lg: { text: "text-2xl", mark: 26 },
};

/** "visual-omp" in Geist Mono 600 + solid `--accent` block cursor (0.55em × 1em, 4px gap). */
export function Wordmark({ withMark = false, size = "md", blink = false, className }: WordmarkProps) {
	const s = wordmarkSizes[size];
	return (
		<span className={cn("inline-flex items-center gap-2 font-mono font-semibold tracking-normal text-fg", s.text, className)}>
			{withMark && <Mark size={s.mark} />}
			<span className="inline-flex items-center">
				visual-omp
				<span
					aria-hidden
					className={cn("ml-1 inline-block h-[1em] w-[0.55em] bg-accent", blink && "vo-cursor-blink")}
				/>
			</span>
		</span>
	);
}

export interface PulseDotProps {
	/** Screen-reader text; omit when visible text already says it (e.g. inside WorkingIndicator). */
	label?: string;
	className?: string;
}

/** §5.16 compact working form: 8px `--mark-gradient` dot pulsing 1 → 0.45 → 1 (frozen at 60% under reduced motion). */
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
 * omp-is-working row: gradient pulse dot + label. Not a live region (elapsed-time labels would chatter);
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
	/** Turns the signal-shimmer border + work glow on (fades in/out). */
	active: boolean;
	/** Must match the wrapped element's radius, e.g. "rounded-xl". */
	radiusClassName?: string;
	children: ReactNode;
	className?: string;
}

/**
 * §5.16 signal shimmer for any child (composer, inputs): a 1px travelling `--work-gradient` drawn over the child's own
 * 1px border, plus `--work-glow`. Reduced motion: static gradient at 50%, no glow. For plain cards prefer `Card working`.
 */
export function GlowBorder({ active, radiusClassName = "rounded-lg", children, className }: GlowBorderProps) {
	return (
		<div data-active={active ? "" : undefined} className={cn("vo-glow", radiusClassName, className)}>
			{children}
		</div>
	);
}
