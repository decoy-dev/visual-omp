import type { ReactNode } from "react";
import { cn } from "./cn";
import { Skeleton } from "./Display";

export interface StatItem {
	id: string;
	label: ReactNode;
	/** null while loading. */
	value: ReactNode | null;
	/** Small qualifier under the value, such as "Estimated at public API prices". */
	hint?: ReactNode;
}

export interface StatListProps {
	items: readonly StatItem[];
	/** Accessible name for the list. */
	label: string;
	className?: string;
}

/** A row of figures as a definition list: label over value. Avoids a grid of identical cards. */
export function StatList({ items, label, className }: StatListProps) {
	return (
		<dl aria-label={label} className={cn("flex flex-wrap gap-x-10 gap-y-4", className)}>
			{items.map(item => (
				<div key={item.id} className="flex min-w-0 flex-col gap-0.5">
					<dt className="text-sm text-fg-muted">{item.label}</dt>
					<dd className="text-xl font-semibold tabular-nums text-fg">{item.value === null ? <Skeleton width={72} height={22} className="mt-1" /> : item.value}</dd>
					{item.hint && <dd className="max-w-[28ch] text-xs text-fg-faint">{item.hint}</dd>}
				</div>
			))}
		</dl>
	);
}
