import { Broadcast, CheckCircle, Circle, Sparkle, Warning, X, XCircle } from "@phosphor-icons/react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";
import { focusRing, pressSmall } from "./styles";

/** accent and agent = the teal accent; blue = neutral ink (`--accent-2`, kept for existing callers). */
export type ChipTone = "accent" | "blue" | "agent" | "ok" | "warn" | "err" | "neutral";

const chipTones: Record<ChipTone, string> = {
	accent: "bg-accent-muted text-accent",
	blue: "bg-accent-2-muted text-accent-2",
	agent: "bg-agent-muted text-agent",
	ok: "bg-ok-bg text-ok",
	warn: "bg-warn-bg text-warn",
	err: "bg-err-bg text-err",
	neutral: "bg-hover text-fg-muted",
};

export interface ChipProps extends Omit<ComponentPropsWithRef<"span">, "children"> {
	tone?: ChipTone;
	/** Leading 6px dot in the tone color. */
	dot?: boolean;
	/** Leading icon (Phosphor element, rendered 12px). */
	icon?: ReactNode;
	children: ReactNode;
	/** Renders a trailing remove button. */
	onRemove?: () => void;
	/** Accessible name for the remove button; defaults to "Remove". */
	removeLabel?: string;
}

/** 24px pill, tinted by tone. */
export function Chip({ tone = "neutral", dot, icon, children, onRemove, removeLabel = "Remove", className, ...rest }: ChipProps) {
	return (
		<span
			className={cn(
				"inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
				chipTones[tone],
				className,
			)}
			{...rest}
		>
			{dot && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />}
			{icon && <span className="inline-flex shrink-0 [&>svg]:size-3">{icon}</span>}
			<span className="truncate">{children}</span>
			{onRemove && (
				<button
					type="button"
					aria-label={removeLabel}
					onClick={onRemove}
					className={cn(
						"-mr-2 inline-flex size-6 shrink-0 items-center justify-center rounded-full opacity-70 transition-[opacity,scale] duration-(--dur-fast) ease-(--ease-out-quart) hover:opacity-100",
						pressSmall,
						focusRing,
					)}
				>
					<X className="size-3" aria-hidden />
				</button>
			)}
		</span>
	);
}

export type BadgeTone = "accent" | "err" | "neutral";

const badgeTones: Record<BadgeTone, string> = {
	accent: "bg-accent text-accent-fg",
	err: "bg-err text-fg-inverse",
	neutral: "bg-selected text-fg-muted",
};

export interface BadgeProps {
	count: number;
	tone?: BadgeTone;
	/** Counts above this render as "{max}+". */
	max?: number;
	/** Screen-reader text, e.g. "3 unread". Defaults to the number. */
	label?: string;
	className?: string;
}

/** Count badge: 16px min height, pill. */
export function Badge({ count, tone = "accent", max = 99, label, className }: BadgeProps) {
	const text = count > max ? `${max}+` : String(count);
	return (
		<span
			className={cn(
				"inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums leading-none",
				badgeTones[tone],
				className,
			)}
		>
			<span aria-hidden={label ? true : undefined}>{text}</span>
			{label && <span className="sr-only">{label}</span>}
		</span>
	);
}

export type Status = "ok" | "warn" | "err" | "live" | "idle" | "agent";

const statusColors: Record<Status, string> = {
	ok: "bg-ok",
	warn: "bg-warn",
	err: "bg-err",
	live: "bg-live",
	idle: "bg-fg-faint",
	agent: "bg-agent",
};

const statusLabels: Record<Status, string> = {
	ok: "OK",
	warn: "Warning",
	err: "Error",
	live: "Live",
	idle: "Idle",
	agent: "Agent working",
};

const statusText: Record<Status, string> = {
	ok: "text-ok",
	warn: "text-warn",
	err: "text-err",
	live: "text-live",
	idle: "text-fg-faint",
	agent: "text-agent",
};

/** A distinct shape per status, so meaning never rests on color alone. */
const statusGlyphs: Record<Status, ReactNode> = {
	ok: <CheckCircle weight="fill" />,
	warn: <Warning weight="fill" />,
	err: <XCircle weight="fill" />,
	live: <Broadcast weight="bold" />,
	idle: <Circle weight="bold" />,
	agent: <Sparkle weight="fill" />,
};

export interface StatusDotProps {
	status: Status;
	/** Screen-reader label, and the visible text with `showLabel`; defaults to the status name. */
	label?: string;
	/** 2px `--panel` ring for dots overlapping avatars/icons. */
	ringed?: boolean;
	/** Draw a 14px status glyph (check, triangle, cross…) instead of the plain dot. */
	glyph?: boolean;
	/** Show the label as visible text after the dot or glyph. */
	showLabel?: boolean;
	className?: string;
}

/**
 * 8px status dot; `live` pulses (static under reduced motion). Always carries sr-only text. Where color carries the
 * meaning, pass `glyph` or `showLabel` so the status is also readable without color.
 */
export function StatusDot({ status, label, ringed, glyph, showLabel, className }: StatusDotProps) {
	const text = label ?? statusLabels[status];
	const mark = glyph ? (
		<span aria-hidden className={cn("inline-flex size-3.5 shrink-0 [&>svg]:size-3.5", statusText[status])}>
			{statusGlyphs[status]}
		</span>
	) : (
		<span className="relative inline-flex size-2 shrink-0">
			{status === "live" && <span aria-hidden className={cn("vo-ping absolute inset-0 rounded-full", statusColors[status])} />}
			<span
				aria-hidden
				className={cn("relative size-2 rounded-full", statusColors[status], ringed && "ring-2 ring-panel")}
			/>
		</span>
	);
	if (!showLabel) {
		return (
			<span className={cn("relative inline-flex shrink-0 items-center", className)}>
				{mark}
				<span className="sr-only">{text}</span>
			</span>
		);
	}
	return (
		<span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-muted", className)}>
			{mark}
			<span>{text}</span>
		</span>
	);
}
