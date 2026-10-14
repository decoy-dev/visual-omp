import type { ReactNode } from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";
import { Tooltip } from "./Tooltip";

export interface DefinitionProps {
	/** What the term means, shown in a tooltip on hover and keyboard focus. */
	content: ReactNode;
	/** The term: a KPI label, a limit window name, a count. */
	children: ReactNode;
	className?: string;
}

/** A term with a definition (DESIGN §5): dotted underline, the definition in a tooltip. Focusable so keyboards reach it. */
export function Definition({ content, children, className }: DefinitionProps) {
	return (
		<Tooltip content={content} className="max-w-72 items-start p-2 leading-snug font-normal">
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip must be reachable from the keyboard */}
			<span
				tabIndex={0}
				className={cn(
					"cursor-help rounded-sm underline decoration-fg-faint decoration-dotted decoration-1 underline-offset-3",
					focusRing,
					className,
				)}
			>
				{children}
			</span>
		</Tooltip>
	);
}
