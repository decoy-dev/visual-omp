import * as RT from "@radix-ui/react-tabs";
import { motion } from "motion/react";
import { type ComponentPropsWithRef, createContext, type ReactNode, useContext, useId, useState } from "react";
import { cn } from "./cn";
import { disabledData, focusRing } from "./styles";

export type TabsVariant = "underline" | "pill";
/** Underline heights: `sm` = 28px window tabs, `md` = 32px dock tabs. */
export type TabsSize = "sm" | "md";

const TabsStyle = createContext<{ variant: TabsVariant; size: TabsSize }>({ variant: "underline", size: "md" });

/** Active value + a per-instance id for the shared indicator. Null when a trigger is rendered outside `Tabs`. */
const TabsActive = createContext<{ value: string | undefined; indicatorId: string } | null>(null);

export type TabsProps = ComponentPropsWithRef<typeof RT.Root>;

/** Radix Tabs root that also tracks the active value so the indicator can slide between triggers. */
export function Tabs({ value, defaultValue, onValueChange, ...rest }: TabsProps) {
	const [uncontrolled, setUncontrolled] = useState(defaultValue);
	const current = value ?? uncontrolled;
	const indicatorId = `vo-tabs-${useId()}`;
	return (
		<TabsActive.Provider value={{ value: current, indicatorId }}>
			<RT.Root
				value={value}
				defaultValue={defaultValue}
				onValueChange={(next) => {
					setUncontrolled(next);
					onValueChange?.(next);
				}}
				{...rest}
			/>
		</TabsActive.Provider>
	);
}

export interface TabsListProps extends ComponentPropsWithRef<typeof RT.List> {
	variant?: TabsVariant;
	size?: TabsSize;
}

export function TabsList({ variant = "underline", size = "md", className, ...rest }: TabsListProps) {
	return (
		<TabsStyle.Provider value={{ variant, size }}>
			<RT.List
				className={cn(
					"flex items-center",
					variant === "underline" ? "gap-1 border-b border-border" : "gap-1",
					className,
				)}
				{...rest}
			/>
		</TabsStyle.Provider>
	);
}

export interface TabsTriggerProps extends ComponentPropsWithRef<typeof RT.Trigger> {
	icon?: ReactNode;
	/** Trailing slot, e.g. a Badge or close IconButton. */
	trailing?: ReactNode;
}

export function TabsTrigger({ icon, trailing, className, children, value, ...rest }: TabsTriggerProps) {
	const { variant, size } = useContext(TabsStyle);
	const active = useContext(TabsActive);
	// Outside `Tabs` there is no shared indicator; fall back to a static per-trigger one driven by data-state.
	const staticIndicator = active === null;
	const underline = variant === "underline";
	return (
		<RT.Trigger
			value={value}
			className={cn(
				"relative inline-flex shrink-0 select-none items-center gap-1.5 whitespace-nowrap font-medium text-fg-muted",
				"transition-[color,background-color,scale] duration-(--dur-fast) ease-(--ease-out) hover:text-fg active:scale-[0.97] data-[state=active]:text-fg [&_svg]:size-3.5",
				underline
					? cn(
							"-mb-px rounded-t-sm",
							size === "sm" ? "h-7 px-2 text-sm" : "h-8 px-2.5 text-md",
							staticIndicator &&
								"after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent after:opacity-0 data-[state=active]:after:opacity-100",
						)
					: cn(
							"rounded-full hover:bg-hover",
							staticIndicator && "data-[state=active]:bg-selected",
							size === "sm" ? "h-6 px-2.5 text-sm" : "h-7 px-3 text-md",
						),
				focusRing,
				disabledData,
				className,
			)}
			{...rest}
		>
			{active !== null && active.value === value && (
				<motion.span
					aria-hidden
					layoutId={active.indicatorId}
					className={cn(
						"pointer-events-none absolute",
						underline ? "inset-x-1.5 bottom-0 h-0.5 rounded-full bg-accent" : "inset-0 rounded-full bg-selected",
					)}
				/>
			)}
			<span className="relative inline-flex items-center gap-[inherit]">
				{icon}
				{children}
				{trailing}
			</span>
		</RT.Trigger>
	);
}

export function TabsContent({ className, ...rest }: ComponentPropsWithRef<typeof RT.Content>) {
	return <RT.Content className={cn("rounded-sm", focusRing, className)} {...rest} />;
}
