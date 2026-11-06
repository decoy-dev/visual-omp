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

/** Compact local work intervals share their date and AM/PM only when both endpoints agree. */
export function compactTranscriptTime(start: Date, end: Date | null, now: Date, locale?: string): string {
	const options = { hour: "numeric", minute: "2-digit" } satisfies Intl.DateTimeFormatOptions;
	const spanningDays = end !== null && start.toDateString() !== end.toDateString();
	const spanningYears = end !== null && start.getFullYear() !== end.getFullYear();
	const prefix = (value: Date) => {
		if (!spanningDays && value.toDateString() === now.toDateString()) return "";
		return `${value.toLocaleDateString(locale, { month: "short", day: "numeric", ...(spanningYears || value.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) })} · `;
	};
	let first = start.toLocaleTimeString(locale, options);
	if (!end || sameMinute(start.getTime(), end.getTime())) return prefix(start) + first;
	const last = end.toLocaleTimeString(locale, options);
	if (spanningDays) return `${prefix(start)}${first} - ${prefix(end)}${last}`;
	const formatter = new Intl.DateTimeFormat(locale, options);
	const firstPeriod = formatter.formatToParts(start).find(part => part.type === "dayPeriod")?.value;
	const lastPeriod = formatter.formatToParts(end).find(part => part.type === "dayPeriod")?.value;
	if (firstPeriod && firstPeriod === lastPeriod) first = first.replace(firstPeriod, "").trim();
	return `${prefix(start)}${first}-${last}`;
}

/** Recorded wall-clock metadata only. Relative durations and reply announcements use separate paths. */
export function TranscriptTime({ timestamp, through, previous, className, label, inControl = false }: {
	timestamp: TranscriptTimestamp;
	/** A work summary spans its first call through its latest recorded activity. */
	through?: TranscriptTimestamp;
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
	const fullOptions = { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" } satisfies Intl.DateTimeFormatOptions;
	const end = dateOf(through);
	const rangeEnd = end && end.getTime() > date.getTime() ? end : null;
	const short = compactTranscriptTime(date, rangeEnd, now);
	const detail = date.toLocaleString(undefined, fullOptions) + (rangeEnd ? ` - ${rangeEnd.toLocaleString(undefined, fullOptions)}` : "");
	const description = label ? `${label}: ${detail}` : detail;
	return (
		<Tooltip content={description} open={open} onOpenChange={setOpen}>
			<time ref={ref} dateTime={date.toISOString()} data-through={rangeEnd?.toISOString()} aria-label={description} aria-describedby={undefined} tabIndex={inControl ? undefined : 0} className={cn("shrink-0 whitespace-nowrap text-xs font-normal text-fg-faint tabular-nums", !inControl && "rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", className)}>
				{label && <span>{label} </span>}
				<span className={sameMinute(timestamp, previous) ? "invisible" : undefined}>{short}</span>
			</time>
		</Tooltip>
	);
}
