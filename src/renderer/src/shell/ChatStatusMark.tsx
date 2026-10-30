import { ChatCircleIcon, ChecksIcon, CircleNotchIcon, ClockCounterClockwiseIcon, PowerIcon, QuestionIcon, RobotIcon, XCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../ui";
import type { ChatStatus } from "./hooks";

/**
 * Chat status for sidebar rows, project overviews, Home and the chat header. Every state is its own bold icon, so it
 * reads without color: a spinning notch while omp works, a pulsing robot while only its helpers work, a question mark
 * while it waits for an answer, an X for an error and a power symbol for a chat open with omp running. A saved chat, or
 * an open one whose omp is not running, shows a small faint history clock: saved history or an inactive chat. An unseen
 * result
 * on an inactive chat shows double checks (or the question mark when omp asked something); on an active chat it is an
 * `--info` badge ringed in the row's color (rows set `--mark-overlay` to their hover or selected overlay), so the state
 * stays visible. `quiet` (inactive open chats in the Projects tree, whose status shows under Current chats) draws a
 * small faint chat bubble: open in the app, whether or not omp runs. Reduced motion freezes the spin and pulse
 * (theme/base.css). `label` is screen-reader text.
 */
export function ChatStatusMark({
	status,
	label,
	quiet = false,
	unseen,
	id,
	className,
}: {
	status: ChatStatus;
	label: string;
	quiet?: boolean;
	unseen?: "finished" | "needsInput";
	id?: string;
	className?: string;
}): ReactNode {
	const { t } = useTranslation("shell");
	const unseenLabel = unseen ? t(`sidebar.unseen.${unseen}`) : undefined;
	const active = status === "working" || status === "helpersWorking" || status === "needsInput" || status === "error";
	return (
		<span id={id} title={unseenLabel} className={cn("relative inline-flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5", className)}>
			{unseen && !active ? (
				unseen === "needsInput"
					? <QuestionIcon aria-hidden weight="bold" className="text-warn" />
					: <ChecksIcon aria-hidden weight="bold" className="text-info" />
			) : status === "working" ? (
				<CircleNotchIcon aria-hidden weight="bold" className="animate-spin text-accent" />
			) : status === "helpersWorking" ? (
				<RobotIcon aria-hidden weight="bold" className="animate-[pulse-dot_1.6s_var(--ease-in-out)_infinite] text-accent" />
			) : status === "needsInput" ? (
				<QuestionIcon aria-hidden weight="bold" className="text-warn" />
			) : status === "error" ? (
				<XCircleIcon aria-hidden weight="bold" className="text-err" />
			) : quiet ? (
				<ChatCircleIcon aria-hidden weight="bold" className="size-2.75! text-fg-faint" />
			) : status === "live" ? (
				<PowerIcon aria-hidden weight="bold" className="text-ok" />
			) : (
				<ClockCounterClockwiseIcon aria-hidden weight="bold" className="size-3! text-fg-faint" />
			)}
			{unseen && active && (
				<span
					aria-hidden
					className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-info"
					// Ring in the row's own color: its hover or selected overlay (`--mark-overlay`) painted over `--bg`.
					style={{ boxShadow: "0 0 0 1.5px var(--mark-overlay, transparent), 0 0 0 1.5px var(--bg)" }}
				/>
			)}
			<span className="sr-only">{unseenLabel && unseenLabel !== label ? `${label}. ${unseenLabel}` : label}</span>
		</span>
	);
}
