import { sessionTitleText, splitCardTitle, stripPrivateUseGlyphs } from "@shared/titleCard";
import type { ReactNode } from "react";
import { Chip } from "./Chip";
import { cn } from "./cn";

export interface SessionTitleProps {
	title: string;
	className?: string;
}

/** A saved or live omp title: preserve its card code when its terminal font icon is unavailable. */
export function SessionTitle({ title, className }: SessionTitleProps): ReactNode {
	// Parse before removing private-use icons, or a Nerd Font card would become an unrecognized plain title.
	const card = splitCardTitle(title);
	const text = sessionTitleText(title);
	if (!card) return <span className={cn("block min-w-0 truncate", className)} title={text}>{text}</span>;
	const icon = stripPrivateUseGlyphs(card.icon);
	return (
		<span className={cn("flex min-w-0 max-w-full items-center gap-1.5", className)} title={text}>
			{icon && <span aria-hidden className="shrink-0">{icon}</span>}
			<Chip className="h-5 px-1.5 font-mono">{card.code}</Chip>
			<span className="sr-only">: </span>
			<span className="min-w-0 truncate">{stripPrivateUseGlyphs(card.title)}</span>
		</span>
	);
}
