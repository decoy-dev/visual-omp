import * as RT from "@radix-ui/react-tabs";
import { type ComponentPropsWithRef, createContext, type ReactNode, useContext } from "react";
import { cn } from "./cn";
import { disabledData, focusRing } from "./styles";

export type TabsVariant = "underline" | "pill";
/** Underline heights: `sm` = 28px window tabs, `md` = 32px dock tabs. */
export type TabsSize = "sm" | "md";

const TabsStyle = createContext<{ variant: TabsVariant; size: TabsSize }>({ variant: "underline", size: "md" });

export const Tabs = RT.Root;

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

export function TabsTrigger({ icon, trailing, className, children, ...rest }: TabsTriggerProps) {
	const { variant, size } = useContext(TabsStyle);
	return (
		<RT.Trigger
			className={cn(
				"relative inline-flex shrink-0 select-none items-center gap-1.5 whitespace-nowrap font-medium text-fg-muted",
				"transition-colors duration-(--dur-fast) ease-(--ease-out) hover:text-fg data-[state=active]:text-fg [&_svg]:size-3.5",
				variant === "underline"
					? cn(
							"-mb-px rounded-t-sm",
							size === "sm" ? "h-7 px-2 text-sm" : "h-8 px-2.5 text-md",
							"after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent after:opacity-0 after:transition-opacity after:duration-(--dur-fast)",
							"data-[state=active]:after:opacity-100",
						)
					: cn(
							"rounded-full hover:bg-hover data-[state=active]:bg-selected",
							size === "sm" ? "h-6 px-2.5 text-sm" : "h-7 px-3 text-md",
						),
				focusRing,
				disabledData,
				className,
			)}
			{...rest}
		>
			{icon}
			{children}
			{trailing}
		</RT.Trigger>
	);
}

export function TabsContent({ className, ...rest }: ComponentPropsWithRef<typeof RT.Content>) {
	return <RT.Content className={cn("rounded-sm", focusRing, className)} {...rest} />;
}
