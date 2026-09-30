import { cn } from "./cn";

export type ContextZone = "normal" | "warn" | "err";

/** <60% normal · 60–80% warn · >80% err (DESIGN §5.17). */
export function contextZone(percent: number): ContextZone {
	if (percent > 80) return "err";
	if (percent >= 60) return "warn";
	return "normal";
}

const zoneStroke: Record<ContextZone, string> = {
	normal: "var(--accent)",
	warn: "var(--warn)",
	err: "var(--err)",
};

const zoneText: Record<ContextZone, string> = {
	normal: "text-fg-muted",
	warn: "text-warn",
	err: "text-err",
};

export interface ContextRingProps {
	/** Percent of the context window used, 0–100. */
	value: number;
	/** Diameter in px (20 per spec). */
	size?: number;
	/** Show "62%" next to the ring. Screen readers always get "62% of context used". */
	showLabel?: boolean;
	className?: string;
}

/** Context-usage ring: 2.5px arc from 12 o'clock, round cap; warn/err zones recolor and >80% slowly pulses. */
export function ContextRing({ value, size = 20, showLabel = false, className }: ContextRingProps) {
	const pct = Math.min(100, Math.max(0, value));
	const rounded = Math.round(pct);
	const zone = contextZone(pct);
	const stroke = 2.5;
	const r = (size - stroke) / 2;
	const circumference = 2 * Math.PI * r;
	const c = size / 2;
	return (
		<span
			role="meter"
			aria-label="Context usage"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={rounded}
			aria-valuetext={`${rounded}% of context used`}
			className={cn("inline-flex items-center gap-1.5", className)}
		>
			<svg
				width={size}
				height={size}
				viewBox={`0 0 ${size} ${size}`}
				aria-hidden
				className={zone === "err" ? "vo-slow-pulse" : undefined}
			>
				<circle cx={c} cy={c} r={r} fill="none" stroke="var(--border-strong)" strokeWidth={stroke} />
				{pct > 0 && (
					<circle
						cx={c}
						cy={c}
						r={r}
						fill="none"
						stroke={zoneStroke[zone]}
						strokeWidth={stroke}
						strokeLinecap="round"
						strokeDasharray={circumference}
						strokeDashoffset={circumference * (1 - pct / 100)}
						transform={`rotate(-90 ${c} ${c})`}
						className="transition-[stroke-dashoffset,stroke] duration-(--dur-slow) ease-(--ease-out)"
					/>
				)}
			</svg>
			{showLabel && (
				<span aria-hidden className={cn("font-mono text-xs tabular-nums", zoneText[zone])}>
					{rounded}%
				</span>
			)}
		</span>
	);
}
