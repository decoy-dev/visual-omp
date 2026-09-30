import { Check, Minus } from "lucide-react";
import { type ComponentPropsWithRef, type ReactNode, useEffect, useId, useImperativeHandle, useRef } from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";

const boxBase = cn(
	"peer size-4 shrink-0 appearance-none border border-border-strong bg-panel shadow-(--shadow-card)",
	"transition-[background-color,border-color] duration-(--dur-fast) ease-(--ease-out)",
	"hover:border-fg-faint disabled:cursor-not-allowed",
	focusRing,
);

function Row({
	id,
	label,
	description,
	descId,
	disabled,
	className,
	children,
}: {
	id: string;
	label?: ReactNode;
	description?: ReactNode;
	descId?: string;
	disabled?: boolean;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={cn("flex items-start gap-2.5", disabled && "cursor-not-allowed opacity-45", className)}>
			<span className="relative mt-px inline-flex size-4 shrink-0 items-center justify-center">{children}</span>
			{label && (
				<div className="min-w-0">
					<label htmlFor={id} className={cn("block text-md text-fg", disabled && "cursor-not-allowed")}>
						{label}
					</label>
					{description && (
						<p id={descId} className="mt-0.5 text-sm text-fg-muted">
							{description}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

export interface CheckboxProps extends Omit<ComponentPropsWithRef<"input">, "type" | "onChange"> {
	label?: ReactNode;
	description?: ReactNode;
	/** Mixed state (sets the DOM `indeterminate` flag; announced as "mixed"). */
	indeterminate?: boolean;
	onCheckedChange?: (checked: boolean) => void;
}

/** Native checkbox (keyboard/forms for free) drawn as a 16px box; the label row supplies a ≥24px target. */
export function Checkbox({
	label,
	description,
	indeterminate = false,
	onCheckedChange,
	id,
	disabled,
	className,
	ref,
	...rest
}: CheckboxProps) {
	const autoId = useId();
	const inputId = id ?? autoId;
	const descId = description ? `${inputId}-desc` : undefined;
	const inner = useRef<HTMLInputElement>(null);
	useImperativeHandle(ref, () => inner.current as HTMLInputElement);
	useEffect(() => {
		if (inner.current) inner.current.indeterminate = indeterminate;
	}, [indeterminate]);
	return (
		<Row id={inputId} label={label} description={description} descId={descId} disabled={disabled} className={className}>
			<input
				ref={inner}
				id={inputId}
				type="checkbox"
				disabled={disabled}
				aria-describedby={descId}
				onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
				className={cn(
					boxBase,
					"rounded-[4px] checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent",
				)}
				{...rest}
			/>
			{indeterminate ? (
				<Minus aria-hidden className="pointer-events-none absolute size-3 text-accent-fg [stroke-width:2.5]" />
			) : (
				<Check
					aria-hidden
					className="pointer-events-none absolute size-3 text-accent-fg opacity-0 [stroke-width:2.5] peer-checked:opacity-100"
				/>
			)}
		</Row>
	);
}

export interface RadioOption<V extends string> {
	value: V;
	label: ReactNode;
	description?: ReactNode;
	disabled?: boolean;
}

export interface RadioGroupProps<V extends string> {
	value: V;
	onValueChange: (value: V) => void;
	options: readonly RadioOption<V>[];
	/** Group legend (visible). */
	label?: ReactNode;
	/** Accessible name when there's no visible legend. */
	"aria-label"?: string;
	name?: string;
	orientation?: "vertical" | "horizontal";
	disabled?: boolean;
	className?: string;
}

/** Native radio group: arrow keys move + select, Tab enters/leaves the group. */
export function RadioGroup<V extends string>({
	value,
	onValueChange,
	options,
	label,
	name,
	orientation = "vertical",
	disabled,
	className,
	...aria
}: RadioGroupProps<V>) {
	const autoId = useId();
	const groupName = name ?? autoId;
	return (
		<fieldset role="radiogroup" disabled={disabled} className={cn("m-0 min-w-0 border-0 p-0", className)} {...aria}>
			{label && <legend className="mb-2 p-0 text-md font-medium text-fg">{label}</legend>}
			<div className={cn("flex", orientation === "vertical" ? "flex-col gap-2" : "flex-row flex-wrap gap-x-5 gap-y-2")}>
				{options.map((o) => {
					const optionId = `${groupName}-${o.value}`;
					const descId = o.description ? `${optionId}-desc` : undefined;
					const optionDisabled = disabled || o.disabled;
					return (
						<Row
							key={o.value}
							id={optionId}
							label={o.label}
							description={o.description}
							descId={descId}
							disabled={optionDisabled}
						>
							<input
								id={optionId}
								type="radio"
								name={groupName}
								value={o.value}
								checked={value === o.value}
								disabled={optionDisabled}
								aria-describedby={descId}
								onChange={() => onValueChange(o.value)}
								className={cn(boxBase, "rounded-full checked:border-[5px] checked:border-accent")}
							/>
						</Row>
					);
				})}
			</div>
		</fieldset>
	);
}
