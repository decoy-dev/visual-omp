/**
 * A measurement within a known range, such as how much of a plan limit is used (`role="meter"`). Task
 * progress uses `Progress`. A meter always sits next to text that states the value; color is never the
 * only signal, so warning and exhausted states add a glyph.
 */
import { Warning, WarningCircle } from "@phosphor-icons/react";
import { cn } from "./cn";

export type MeterTone = "accent" | "warn" | "err";

/** App warning thresholds: 70% warns, 90% or a provider-reported exhaustion is an error. */
export function meterTone(fraction: number, exhausted = false): MeterTone {
	if (exhausted || fraction >= 0.9) return "err";
	if (fraction >= 0.7) return "warn";
	return "accent";
}

const fills: Record<MeterTone, string> = { accent: "bg-accent", warn: "bg-warn", err: "bg-err" };

export interface MeterProps {
	/** 0-1. */
	fraction: number;
	/** Accessible name, such as "Claude 5-hour limit". */
	label: string;
	/** Spoken value, such as "67% used, resets in 7 hours". */
	valueText: string;
	tone?: MeterTone;
	className?: string;
}

/** 6px track with a fill; the glyph appears at warn and error so the state survives without color. */
export function Meter({ fraction, label, valueText, tone, className }: MeterProps) {
	const clamped = Math.min(1, Math.max(0, fraction));
	const resolved = tone ?? meterTone(clamped);
	const percent = Math.round(clamped * 100);
	return (
		<div className={cn("flex min-w-0 items-center gap-2", className)}>
			<div
				role="meter"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent}
				aria-valuetext={valueText}
				className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border-strong"
			>
				<div
					className={cn("h-full rounded-full transition-[width,background-color] duration-(--dur-spring-gentle) ease-(--ease-spring)", fills[resolved])}
					style={{ width: `${percent}%` }}
				/>
			</div>
			{resolved === "warn" && <Warning aria-hidden className="size-3.5 shrink-0 text-warn" />}
			{resolved === "err" && <WarningCircle aria-hidden className="size-3.5 shrink-0 text-err" />}
		</div>
	);
}
