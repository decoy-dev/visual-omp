import { CircleIcon, CircleNotch, Question } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "../ui";
import type { ChatStatus } from "./hooks";

/**
 * Chat status for rows and tabs. Each status has its own shape, so it reads without color: a spinning notch while
 * omp works, a question mark while it waits for an answer, a filled circle for a chat open in a tab and a hollow
 * circle for a saved chat. `label` is the screen-reader text.
 */
export function ChatStatusMark({ status, label, className }: { status: ChatStatus; label: string; className?: string }): ReactNode {
	return (
		<span className={cn("inline-flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5", className)}>
			{status === "working" ? (
				<CircleNotch aria-hidden weight="bold" className="animate-spin text-accent" />
			) : status === "needsInput" ? (
				<Question aria-hidden weight="bold" className="text-warn" />
			) : status === "live" ? (
				<CircleIcon aria-hidden weight="fill" className="size-2.5! text-ok" />
			) : (
				<CircleIcon aria-hidden weight="bold" className="size-2.5! text-fg-faint" />
			)}
			<span className="sr-only">{label}</span>
		</span>
	);
}
