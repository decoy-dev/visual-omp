import { cn } from "./cn";

export interface SpinnerProps {
	/** Pixel size; 14 by default. */
	size?: number;
	/** When set, the spinner announces itself (role=status); otherwise it is decorative. */
	label?: string;
	/** `accent` per spec; `current` inherits text color (inside filled buttons). */
	tone?: "accent" | "current";
	className?: string;
}

/** 14px arc, 2px stroke, `--accent` by default, 0.8s rotation; static under reduced motion. */
export function Spinner({ size = 14, label, tone = "accent", className }: SpinnerProps) {
	return (
		<span
			role={label ? "status" : undefined}
			aria-hidden={label ? undefined : true}
			className={cn("inline-flex shrink-0", tone === "accent" && "text-accent", className)}
		>
			<svg className="vo-spin" width={size} height={size} viewBox="0 0 16 16" fill="none">
				<circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
				<path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			</svg>
			{label && <span className="sr-only">{label}</span>}
		</span>
	);
}
