import { CircleHalf } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export type StatusBadgeTone = "ok" | "warn" | "err" | "info" | "neutral";

const tones: Record<StatusBadgeTone, string> = {
	ok: "bg-ok-bg text-ok",
	warn: "bg-warn-bg text-warn",
	err: "bg-err-bg text-err",
	info: "bg-info-bg text-info",
	neutral: "bg-hover text-fg-muted",
};

/** The dot's shape carries the state with the color: filled for ok and info, half for warn, a diamond for err, hollow for neutral. */
function Dot({ tone }: { tone: StatusBadgeTone }) {
	if (tone === "warn") return <CircleHalf aria-hidden weight="fill" className="size-2 shrink-0" />;
	if (tone === "err") return <span aria-hidden className="size-1.5 shrink-0 rotate-45 bg-current" />;
	if (tone === "neutral") return <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-current" />;
	return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />;
}

export interface StatusBadgeProps {
	tone: StatusBadgeTone;
	/** Sentence-case state, such as "Near limit", "Working", "Done". */
	children: ReactNode;
	className?: string;
}

/** 20px status pill (DESIGN §5): a tone dot and a short label on the tone's tinted fill. */
export function StatusBadge({ tone, children, className }: StatusBadgeProps) {
	return (
		<span
			className={cn(
				"inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 rounded-full px-2 text-sm font-medium whitespace-nowrap",
				tones[tone],
				className,
			)}
		>
			<Dot tone={tone} />
			<span className="truncate">{children}</span>
		</span>
	);
}
