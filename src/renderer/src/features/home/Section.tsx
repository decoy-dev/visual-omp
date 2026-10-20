import type { ReactNode } from "react";
import { cn } from "@/ui";
import { focusRing } from "@/ui/styles";

export interface HomeSectionAction {
	label: string;
	onClick(): void;
	/** For a show more or fewer toggle: whether the extra rows are open. */
	expanded?: boolean;
}

/** A Home section's 40px heading row: the heading, and a quiet accent text action on the right (DESIGN §4.24). */
export function HomeSectionHeader({ id, title, action }: { id: string; title: string; action?: HomeSectionAction }): ReactNode {
	return (
		<div className="mb-stack flex h-10 items-center justify-between gap-3">
			<h2 id={id} className="text-lg font-semibold text-fg">
				{title}
			</h2>
			{action && (
				<button
					type="button"
					onClick={action.onClick}
					aria-expanded={action.expanded}
					className={cn("shrink-0 rounded-sm text-md text-accent underline-offset-2 hover:underline", focusRing)}
				>
					{action.label}
				</button>
			)}
		</div>
	);
}
