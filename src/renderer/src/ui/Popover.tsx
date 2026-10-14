import * as PP from "@radix-ui/react-popover";
import { type ComponentPropsWithRef, type ReactNode, useId } from "react";
import { cn } from "./cn";
import { floatingSurface } from "./styles";

export const Popover = PP.Root;
export const PopoverTrigger = PP.Trigger;
export const PopoverAnchor = PP.Anchor;
export const PopoverClose = PP.Close;

export interface PopoverContentProps extends Omit<ComponentPropsWithRef<typeof PP.Content>, "title"> {
	/** Fixed width in px (or any CSS length). */
	width?: number | string;
	/** Header row: 13px semibold title, hairline below. Also names the popover for assistive technology. */
	title?: ReactNode;
	/** Muted 12px line under the title. */
	description?: ReactNode;
}

export function PopoverContent({
	className,
	width,
	style,
	sideOffset = 8,
	collisionPadding = 8,
	align = "center",
	title,
	description,
	children,
	...rest
}: PopoverContentProps) {
	const titleId = useId();
	return (
		<PP.Portal>
			<PP.Content
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				align={align}
				style={width === undefined ? style : { width, ...style }}
				className={cn(floatingSurface, "p-3 text-md", className)}
				aria-labelledby={title ? titleId : undefined}
				{...rest}
			>
				{title && (
					<header className="-mx-3 -mt-3 mb-3 border-b border-border p-3">
						<p id={titleId} className="text-md font-semibold text-fg">
							{title}
						</p>
						{description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
					</header>
				)}
				{children}
			</PP.Content>
		</PP.Portal>
	);
}
