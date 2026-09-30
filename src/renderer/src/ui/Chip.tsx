import { X } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";

/** accent = Signal Cyan, blue = Electric Blue (`--accent-2`), agent = fuchsia. */
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
	/** Leading icon (lucide element, rendered 12px). */
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
				"inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold",
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
						"-mr-2 inline-flex size-6 shrink-0 items-center justify-center rounded-full opacity-70 transition-opacity duration-(--dur-fast) hover:opacity-100",
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

export interface StatusDotProps {
	status: Status;
	/** Screen-reader label; defaults to the status name. */
	label?: string;
	/** 2px `--panel` ring for dots overlapping avatars/icons. */
	ringed?: boolean;
	className?: string;
}

/** 8px status dot; `live` pulses (static under reduced motion). Always carries sr-only text. */
export function StatusDot({ status, label, ringed, className }: StatusDotProps) {
	return (
		<span className={cn("relative inline-flex size-2 shrink-0", className)}>
			{status === "live" && <span aria-hidden className={cn("vo-ping absolute inset-0 rounded-full", statusColors[status])} />}
			<span
				aria-hidden
				className={cn("relative size-2 rounded-full", statusColors[status], ringed && "ring-2 ring-panel")}
			/>
			<span className="sr-only">{label ?? statusLabels[status]}</span>
		</span>
	);
}
