import { Info, Warning, WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export type NoticeTone = "info" | "warn" | "err";

const noticeTones: Record<NoticeTone, { box: string; icon: ReactNode }> = {
	info: { box: "border-border bg-inset text-fg-muted", icon: <Info aria-hidden className="size-4 text-info" /> },
	warn: { box: "border-border bg-warn-bg text-fg", icon: <Warning aria-hidden className="size-4 text-warn" /> },
	err: { box: "border-border bg-err-bg text-fg", icon: <WarningCircle aria-hidden className="size-4 text-err" /> },
};

export interface NoticeProps {
	tone?: NoticeTone;
	children: ReactNode;
	/** Buttons on the right, such as "Try again". */
	actions?: ReactNode;
	className?: string;
}

/** Inline banner: glyph + message (+ optional actions on the right). Errors are announced. */
export function Notice({ tone = "info", children, actions, className }: NoticeProps) {
	const style = noticeTones[tone];
	return (
		<div role={tone === "err" ? "alert" : "status"} className={cn("flex items-start gap-3 rounded-md border px-3 py-3 text-sm", style.box, className)}>
			<span className="mt-px inline-flex shrink-0">{style.icon}</span>
			<div className="min-w-0 flex-1 break-words">{children}</div>
			{actions && <div className="-my-1 flex shrink-0 items-center gap-1.5">{actions}</div>}
		</div>
	);
}
