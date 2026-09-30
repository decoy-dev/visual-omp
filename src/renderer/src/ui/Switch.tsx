import * as RS from "@radix-ui/react-switch";
import { type ComponentPropsWithRef, type ReactNode, useId } from "react";
import { cn } from "./cn";
import { disabledNative, focusRing } from "./styles";

export interface SwitchProps extends Omit<ComponentPropsWithRef<typeof RS.Root>, "children"> {
	/** Visible label on the left; also the accessible name. */
	label?: ReactNode;
	/** Helper text under the label (wired via aria-describedby). */
	description?: ReactNode;
}

/** 40×22 track, 18px knob. With `label` it renders a full settings row: label/description left, switch right. */
export function Switch({ label, description, id, className, ...rest }: SwitchProps) {
	const autoId = useId();
	const switchId = id ?? autoId;
	const descId = description ? `${switchId}-desc` : undefined;
	const control = (
		<RS.Root
			id={switchId}
			aria-describedby={descId}
			className={cn(
				"group relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full bg-border-strong p-0.5",
				"transition-colors duration-(--dur-fast) ease-(--ease-out) data-[state=checked]:bg-accent",
				focusRing,
				disabledNative,
				!label && className,
			)}
			{...rest}
		>
			<RS.Thumb className="block size-[18px] rounded-full bg-panel shadow-(--shadow-card) transition-transform duration-(--dur-fast) ease-(--ease-out) data-[state=checked]:translate-x-[18px]" />
		</RS.Root>
	);
	if (!label) return control;
	return (
		<div className={cn("flex items-start justify-between gap-4", className)}>
			<div className="min-w-0 pt-px">
				<label htmlFor={switchId} className="block text-md text-fg">
					{label}
				</label>
				{description && (
					<p id={descId} className="mt-0.5 text-sm text-fg-muted">
						{description}
					</p>
				)}
			</div>
			{control}
		</div>
	);
}
