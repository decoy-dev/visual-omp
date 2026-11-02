import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn, Tooltip } from "../../ui";
import { useLocalDay } from "./localDay";

export type TranscriptTimestamp = string | number | null | undefined;

function dateOf(timestamp: TranscriptTimestamp): Date | null {
	if (timestamp === null || timestamp === undefined || timestamp === "" || timestamp === 0) return null;
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Consecutive tool steps share a visible minute; the full time remains available on each step. */
export function sameMinute(timestamp: TranscriptTimestamp, previous: TranscriptTimestamp): boolean {
	const date = dateOf(timestamp);
	const before = dateOf(previous);
	return date !== null && before !== null && Math.floor(date.getTime() / 60_000) === Math.floor(before.getTime() / 60_000);
}

/** Recorded wall-clock metadata only. Relative durations and reply announcements use separate paths. */
export function TranscriptTime({ timestamp, previous, className, label, inControl = false }: {
	timestamp: TranscriptTimestamp;
	previous?: TranscriptTimestamp;
	className?: string;
	label?: string;
	/** The containing disclosure is already the keyboard stop. */
	inControl?: boolean;
}): ReactNode {
	const localDay = useLocalDay();
	const ref = useRef<HTMLTimeElement>(null);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (!inControl) return;
		const control = ref.current?.closest<HTMLElement>("button, [role=button], a[href]");
		if (!control) return;
		const focus = () => { if (control.matches(":focus-visible")) setOpen(true); };
		const blur = () => setOpen(false);
		control.addEventListener("focus", focus);
		control.addEventListener("blur", blur);
		return () => {
			control.removeEventListener("focus", focus);
			control.removeEventListener("blur", blur);
		};
	}, [inControl, timestamp]);
	const date = dateOf(timestamp);
	if (!date) return null;
	const now = new Date(localDay);
	const today = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
	const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	const short = today ? time : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) })} · ${time}`;
	const full = date.toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
	const description = label ? `${label}: ${full}` : full;
	return (
		<Tooltip content={description} open={open} onOpenChange={setOpen}>
			<time ref={ref} dateTime={date.toISOString()} aria-label={description} aria-describedby={undefined} tabIndex={inControl ? undefined : 0} className={cn("shrink-0 whitespace-nowrap text-xs font-normal text-fg-faint tabular-nums", !inControl && "rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", className)}>
				{label && <span>{label} </span>}
				<span className={sameMinute(timestamp, previous) ? "invisible" : undefined}>{short}</span>
			</time>
		</Tooltip>
	);
}
