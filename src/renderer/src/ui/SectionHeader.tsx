import type { ReactNode } from "react";
import { cn } from "./cn";

export interface SectionHeaderProps {
	title: ReactNode;
	/** One sentence under the title; wraps. */
	description?: ReactNode;
	/** Right-aligned controls such as "Refresh" or a range select. */
	actions?: ReactNode;
	/** For `aria-labelledby` on the section. */
	id?: string;
	as?: "h2" | "h3";
	className?: string;
}

/** Heading for a section of a page: title, optional description, actions on the right. 24px above its content. */
export function SectionHeader({ title, description, actions, id, as: Tag = "h2", className }: SectionHeaderProps) {
	return (
		<div className={cn("mb-4 flex flex-wrap items-start gap-x-4 gap-y-2", className)}>
			<div className="min-w-0 flex-1">
				<Tag id={id} className="text-lg font-semibold text-fg">
					{title}
				</Tag>
				{description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
			</div>
			{actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}
