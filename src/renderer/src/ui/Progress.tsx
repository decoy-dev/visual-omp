import { cn } from "./cn";

export interface ProgressProps {
	/** 0–100. Omit for indeterminate. */
	value?: number;
	/** Accessible name, e.g. "Installing omp". */
	"aria-label": string;
	/** Visible caption row above the bar (label left, percent right). */
	showValue?: boolean;
	tone?: "accent" | "ok" | "warn" | "err";
	className?: string;
}

const fills: Record<NonNullable<ProgressProps["tone"]>, string> = {
	accent: "bg-accent",
	ok: "bg-ok",
	warn: "bg-warn",
	err: "bg-err",
};

/** 6px pill bar; determinate width follows the value on the gentle spring, indeterminate slides two segments (fades under reduced motion). */
export function Progress({ value, showValue, tone = "accent", className, ...aria }: ProgressProps) {
	const determinate = value !== undefined;
	const pct = determinate ? Math.min(100, Math.max(0, value)) : 0;
	return (
		<div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
			{showValue && (
				<div className="flex items-baseline justify-between text-sm">
					<span className="truncate text-fg-muted">{aria["aria-label"]}</span>
					{determinate && <span className="font-mono text-xs tabular-nums text-fg-faint">{Math.round(pct)}%</span>}
				</div>
			)}
			<div
				role="progressbar"
				aria-valuemin={determinate ? 0 : undefined}
				aria-valuemax={determinate ? 100 : undefined}
				aria-valuenow={determinate ? Math.round(pct) : undefined}
				className="relative h-1.5 w-full overflow-hidden rounded-full bg-border-strong"
				{...aria}
			>
				{determinate ? (
					<div
						className={cn(
							"h-full rounded-full transition-[width,background-color] duration-(--dur-spring-gentle) ease-(--ease-spring)",
							fills[tone],
						)}
						style={{ width: `${pct}%` }}
					/>
				) : (
					<>
						<div className={cn("vo-indeterminate-long rounded-full", fills[tone])} />
						<div className={cn("vo-indeterminate-short rounded-full", fills[tone])} />
					</>
				)}
			</div>
		</div>
	);
}

export interface StepDotsProps {
	total: number;
	/** 0-based current step. */
	current: number;
	/** Visible "Step 2 of 4" text next to the dots. */
	showLabel?: boolean;
	className?: string;
}

/** ●●○○ step progress: done = accent, current = accent + pulse ring, todo = `--control-border` (3:1 on every surface). */
export function StepDots({ total, current, showLabel, className }: StepDotsProps) {
	const text = `Step ${current + 1} of ${total}`;
	return (
		<div className={cn("inline-flex items-center gap-3", className)}>
			<div
				role="progressbar"
				aria-valuemin={1}
				aria-valuemax={total}
				aria-valuenow={current + 1}
				aria-valuetext={text}
				className="inline-flex items-center gap-2"
			>
				{Array.from({ length: total }, (_, i) => (
					<span key={i} className="relative inline-flex size-2">
						{i === current && <span aria-hidden className="vo-ping absolute inset-0 rounded-full bg-accent" />}
						<span
							className={cn(
								"relative size-2 rounded-full transition-colors duration-(--dur)",
								i <= current ? "bg-accent" : "bg-control",
								i === current && "ring-4 ring-accent-muted",
							)}
						/>
					</span>
				))}
			</div>
			{showLabel && <span className="text-sm text-fg-muted">{text}</span>}
		</div>
	);
}
