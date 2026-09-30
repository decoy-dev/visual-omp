import * as TG from "@radix-ui/react-toggle-group";
import { motion } from "motion/react";
import { type ReactNode, useId } from "react";
import { cn } from "./cn";
import { disabledData, focusRing } from "./styles";

export interface SegmentedOption<V extends string> {
	value: V;
	label: ReactNode;
	icon?: ReactNode;
	disabled?: boolean;
	/** Needed when `label` is icon-only. */
	ariaLabel?: string;
}

export interface SegmentedProps<V extends string> {
	value: V;
	onValueChange: (value: V) => void;
	options: readonly SegmentedOption<V>[];
	/** Accessible name for the group. */
	"aria-label": string;
	size?: "sm" | "md";
	disabled?: boolean;
	className?: string;
}

/**
 * Single-select segmented control; arrow keys move between segments, a segment can't be deselected.
 * The selected fill is one shared element that slides between segments (`layoutId`).
 */
export function Segmented<V extends string>({
	value,
	onValueChange,
	options,
	size = "md",
	disabled,
	className,
	...aria
}: SegmentedProps<V>) {
	const indicatorId = `vo-segmented-${useId()}`;
	return (
		<TG.Root
			type="single"
			value={value}
			onValueChange={(next) => {
				// Radix emits "" when the active segment is clicked again; a segmented control never deselects.
				const picked = options.find((o) => o.value === next);
				if (picked) onValueChange(picked.value);
			}}
			disabled={disabled}
			className={cn(
				"inline-flex items-center gap-0.5 rounded-md border border-border bg-inset p-0.5",
				disabled && "cursor-not-allowed opacity-45",
				className,
			)}
			{...aria}
		>
			{options.map((o) => (
				<TG.Item
					key={o.value}
					value={o.value}
					disabled={o.disabled}
					aria-label={o.ariaLabel}
					className={cn(
						"relative inline-flex select-none items-center justify-center gap-1.5 rounded-sm font-medium text-fg-muted",
						"transition-[color,scale] duration-(--dur-fast) ease-(--ease-out) hover:text-fg active:scale-[0.97] data-[state=on]:text-fg",
						"[&_svg]:size-3.5",
						size === "sm" ? "h-6 px-2 text-xs" : "h-[26px] px-2.5 text-sm",
						focusRing,
						disabledData,
					)}
				>
					{o.value === value && (
						<motion.span
							aria-hidden
							layoutId={indicatorId}
							className="pointer-events-none absolute inset-0 rounded-sm border border-border bg-panel shadow-(--shadow-card)"
						/>
					)}
					<span className="relative inline-flex items-center gap-[inherit]">
						{o.icon}
						{o.label}
					</span>
				</TG.Item>
			))}
		</TG.Root>
	);
}
