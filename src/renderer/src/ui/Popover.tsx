import * as PP from "@radix-ui/react-popover";
import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";
import { floatingSurface } from "./styles";

export const Popover = PP.Root;
export const PopoverTrigger = PP.Trigger;
export const PopoverAnchor = PP.Anchor;
export const PopoverClose = PP.Close;

export interface PopoverContentProps extends ComponentPropsWithRef<typeof PP.Content> {
	/** Fixed width in px (or any CSS length). */
	width?: number | string;
}

export function PopoverContent({
	className,
	width,
	style,
	sideOffset = 8,
	collisionPadding = 8,
	align = "center",
	...rest
}: PopoverContentProps) {
	return (
		<PP.Portal>
			<PP.Content
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				align={align}
				style={width === undefined ? style : { width, ...style }}
				className={cn(floatingSurface, "rounded-lg p-3 text-md", className)}
				{...rest}
			/>
		</PP.Portal>
	);
}
