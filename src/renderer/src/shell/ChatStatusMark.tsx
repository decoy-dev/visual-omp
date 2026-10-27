import { CircleIcon, CircleNotch, Question } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../ui";
import type { ChatStatus } from "./hooks";

/**
 * Chat status for sidebar rows and project overviews. Each status has its own shape, so it reads without color: a
 * spinning notch while omp or its helpers work (the label says which), a question mark while it waits for an answer, a
 * filled circle for a chat open with omp running and a hollow circle for a saved chat. `quiet` (open chats in the
 * Projects tree, whose live status shows under Current chats) draws one small muted dot that only says the chat is
 * open. An unseen result adds a teal dot, keeping active work and question marks visible. `label` is screen-reader text.
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
	const active = status === "working" || status === "helpersWorking" || status === "needsInput";
	return (
		<span id={id} title={unseenLabel} className={cn("relative inline-flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5", className)}>
			{unseen && !active ? (
				<span aria-hidden className="size-2 rounded-full bg-accent" />
			) : quiet && !unseen ? (
				<span aria-hidden className="size-1.5 rounded-full bg-fg-muted" />
			) : status === "working" || status === "helpersWorking" ? (
				<CircleNotch aria-hidden weight="bold" className="animate-spin text-accent" />
			) : status === "needsInput" ? (
				<Question aria-hidden weight="bold" className="text-warn" />
			) : status === "live" ? (
				<CircleIcon aria-hidden weight="fill" className="size-2.5! text-ok" />
			) : (
				<CircleIcon aria-hidden weight="bold" className="size-2.5! text-fg-faint" />
			)}
			{unseen && active && <span aria-hidden className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-accent" />}
			<span className="sr-only">{unseenLabel && unseenLabel !== label ? `${label}. ${unseenLabel}` : label}</span>
		</span>
	);
}
