import * as RS from "@radix-ui/react-select";
import { CaretDown, CaretUp, Check } from "@phosphor-icons/react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";
import { disabledNative, floatingSurface, menuItem, menuLabel, menuSeparator } from "./styles";

export type SelectSize = "sm" | "md";

export interface SelectProps {
	value?: string;
	defaultValue?: string;
	onValueChange?: (value: string) => void;
	placeholder?: string;
	size?: SelectSize;
	disabled?: boolean;
	invalid?: boolean;
	id?: string;
	name?: string;
	"aria-label"?: string;
	"aria-describedby"?: string;
	/** Leading icon inside the trigger. */
	icon?: ReactNode;
	/** SelectItem / SelectGroup / SelectSeparator children. */
	children: ReactNode;
	className?: string;
	contentClassName?: string;
}

/** Input-styled trigger + popper list sized to the trigger. */
export function Select({
	placeholder,
	size = "md",
	disabled,
	invalid,
	id,
	icon,
	children,
	className,
	contentClassName,
	"aria-label": ariaLabel,
	"aria-describedby": ariaDescribedBy,
	...root
}: SelectProps) {
	return (
		<RS.Root disabled={disabled} {...root}>
			<RS.Trigger
				id={id}
				aria-label={ariaLabel}
				aria-describedby={ariaDescribedBy}
				aria-invalid={invalid || undefined}
				className={cn(
					"group/select inline-flex min-w-0 select-none items-center gap-2 rounded-md border bg-panel text-left text-fg",
					"transition-[border-color,background-color] duration-(--dur-fast) ease-(--ease-out) hover:border-fg-muted",
					"focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=open]:border-ring",
					"data-placeholder:text-fg-faint [&_svg]:shrink-0",
					invalid ? "border-err" : "border-control",
					size === "sm" ? "h-7 px-2 text-sm" : "h-8 px-2.5 text-md",
					disabledNative,
					className,
				)}
			>
				{icon && <span className="inline-flex text-fg-muted [&>svg]:size-4">{icon}</span>}
				<span className="min-w-0 flex-1 truncate">
					<RS.Value placeholder={placeholder} />
				</span>
				<RS.Icon className="text-fg-faint">
					<CaretDown
						className="size-3.5 transition-transform duration-(--dur) ease-(--ease-out-quart) group-data-[state=open]/select:rotate-180"
						aria-hidden
					/>
				</RS.Icon>
			</RS.Trigger>
			<RS.Portal>
				<RS.Content
					position="popper"
					sideOffset={4}
					collisionPadding={8}
					className={cn(
						floatingSurface,
						"max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden",
						contentClassName,
					)}
				>
					<RS.ScrollUpButton className="flex h-6 items-center justify-center text-fg-faint">
						<CaretUp className="size-3.5" aria-hidden />
					</RS.ScrollUpButton>
					<RS.Viewport className="p-1">{children}</RS.Viewport>
					<RS.ScrollDownButton className="flex h-6 items-center justify-center text-fg-faint">
						<CaretDown className="size-3.5" aria-hidden />
					</RS.ScrollDownButton>
				</RS.Content>
			</RS.Portal>
		</RS.Root>
	);
}

export interface SelectItemProps extends ComponentPropsWithRef<typeof RS.Item> {
	icon?: ReactNode;
	/** Secondary text on the right (not part of the selected value). */
	hint?: ReactNode;
}

export function SelectItem({ icon, hint, className, children, ...rest }: SelectItemProps) {
	return (
		<RS.Item className={cn(menuItem, "pr-8", className)} {...rest}>
			{icon && <span className="inline-flex shrink-0 text-fg-muted [&>svg]:size-4">{icon}</span>}
			<RS.ItemText>{children}</RS.ItemText>
			{hint && <span className="ml-auto pl-3 text-xs text-fg-faint">{hint}</span>}
			<RS.ItemIndicator className="absolute right-2 inline-flex text-accent">
				<Check className="size-4" aria-hidden />
			</RS.ItemIndicator>
		</RS.Item>
	);
}

export const SelectGroup = RS.Group;

export function SelectLabel({ className, ...rest }: ComponentPropsWithRef<typeof RS.Label>) {
	return <RS.Label className={cn(menuLabel, className)} {...rest} />;
}

export function SelectSeparator({ className, ...rest }: ComponentPropsWithRef<typeof RS.Separator>) {
	return <RS.Separator className={cn(menuSeparator, className)} {...rest} />;
}
