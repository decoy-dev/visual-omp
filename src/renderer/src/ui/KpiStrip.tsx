import type { CSSProperties, ReactNode } from "react";
import { cn } from "./cn";
import { Skeleton } from "./Display";

export interface KpiItem {
	id: string;
	/** The figure's name; pass a `Definition` when the figure needs explaining. */
	label: ReactNode;
	/** null while loading. */
	value: ReactNode | null;
	/** One short qualifier under the value, such as the period or what the figure includes. */
	hint?: ReactNode;
}

export interface KpiStripProps {
	items: readonly KpiItem[];
	/** Accessible name for the figures. */
	label: string;
	className?: string;
}

/**
 * Key figures as one segmented card (DESIGN §4.18): the segments sit side by side with hairline dividers,
 * and stack with horizontal hairlines when the card is narrower than 36rem. One instrument instead of a
 * grid of identical cards.
 */
export function KpiStrip({ items, label, className }: KpiStripProps) {
	return (
		<div className={cn("@container/kpi rounded-lg border border-border bg-panel", className)}>
			<dl
				aria-label={label}
				style={{ "--kpi-columns": items.length } as CSSProperties}
				className="grid grid-cols-1 @min-[36rem]/kpi:grid-cols-[repeat(var(--kpi-columns),minmax(0,1fr))]"
			>
				{items.map((item, index) => (
					<div
						key={item.id}
						className={cn("flex min-w-0 flex-col gap-1 p-card", index > 0 && "border-t border-border @min-[36rem]/kpi:border-t-0 @min-[36rem]/kpi:border-l")}
					>
						<dt className="w-fit text-sm font-medium text-fg-muted">{item.label}</dt>
						<dd className="text-xl font-semibold tabular-nums text-fg">{item.value === null ? <Skeleton width={80} height={24} /> : item.value}</dd>
						{item.hint && <dd className="text-xs text-fg-faint">{item.hint}</dd>}
					</div>
				))}
			</dl>
		</div>
	);
}
