import { Search, X } from "lucide-react";
import {
	type ComponentPropsWithRef,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
} from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";

export type InputSize = "sm" | "md" | "lg";

const boxSizes: Record<InputSize, string> = {
	sm: "h-7 px-2 text-sm",
	md: "h-8 px-2.5 text-md",
	lg: "h-10 px-3 text-base",
};

/** Border/focus/error treatment shared by text-like controls. Focus → `--ring` border + 2px outline. */
function boxClass(invalid: boolean, disabled: boolean | undefined): string {
	return cn(
		"flex items-center gap-2 rounded-md border text-fg",
		"transition-[border-color,box-shadow,background-color] duration-(--dur-fast) ease-(--ease-out)",
		"focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring",
		invalid ? "border-err" : "border-border-strong hover:border-fg-faint focus-within:border-ring focus-within:hover:border-ring",
		disabled && "cursor-not-allowed opacity-45",
	);
}

const innerControl =
	"min-w-0 flex-1 self-stretch bg-transparent text-fg outline-none placeholder:text-fg-faint disabled:cursor-not-allowed";

interface FieldTextProps {
	label?: ReactNode;
	description?: ReactNode;
	/** Error text; marks the control invalid and is announced via aria-describedby. */
	error?: ReactNode;
}

/** Resolves ids for label/description/error and the combined aria-describedby. */
function useFieldIds(id: string | undefined, { description, error }: FieldTextProps, describedBy: string | undefined) {
	const autoId = useId();
	const controlId = id ?? autoId;
	const descId = description ? `${controlId}-desc` : undefined;
	const errId = error ? `${controlId}-err` : undefined;
	const ids = [describedBy, descId, errId].filter(Boolean).join(" ");
	return { controlId, descId, errId, describedBy: ids || undefined };
}

function FieldShell({
	controlId,
	descId,
	errId,
	label,
	description,
	error,
	className,
	children,
}: FieldTextProps & { controlId: string; descId?: string; errId?: string; className?: string; children: ReactNode }) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
			{label && (
				<label htmlFor={controlId} className="text-md font-medium text-fg">
					{label}
				</label>
			)}
			{children}
			{description && (
				<p id={descId} className="text-sm text-fg-muted">
					{description}
				</p>
			)}
			{error && (
				<p id={errId} className="flex items-center gap-1.5 text-sm text-err">
					<span aria-hidden className="text-[9px] leading-none">
						▲
					</span>
					{error}
				</p>
			)}
		</div>
	);
}

export interface InputProps extends Omit<ComponentPropsWithRef<"input">, "size">, FieldTextProps {
	size?: InputSize;
	/** Leading icon (lucide element). */
	icon?: ReactNode;
	/** Trailing slot inside the field (unit, Kbd, icon button). */
	trailing?: ReactNode;
	/** Classes for the bordered box (root `className` goes on the outer field wrapper). */
	boxClassName?: string;
}

export function Input({
	size = "md",
	icon,
	trailing,
	label,
	description,
	error,
	id,
	disabled,
	className,
	boxClassName,
	"aria-describedby": ariaDescribedBy,
	...rest
}: InputProps) {
	const ids = useFieldIds(id, { description, error }, ariaDescribedBy);
	return (
		<FieldShell {...ids} label={label} description={description} error={error} className={className}>
			<div className={cn(boxClass(Boolean(error), disabled), "bg-panel", boxSizes[size], boxClassName)}>
				{icon && <span className="inline-flex shrink-0 text-fg-faint [&>svg]:size-4">{icon}</span>}
				<input
					id={ids.controlId}
					disabled={disabled}
					aria-invalid={error ? true : undefined}
					aria-describedby={ids.describedBy}
					className={innerControl}
					{...rest}
				/>
				{trailing && <span className="inline-flex shrink-0 items-center text-fg-faint">{trailing}</span>}
			</div>
		</FieldShell>
	);
}

export interface SearchInputProps
	extends Omit<ComponentPropsWithRef<"input">, "size" | "value" | "onChange" | "type" | "defaultValue"> {
	value: string;
	onValueChange: (value: string) => void;
	size?: "sm" | "md";
	/** Right-side hint shown while empty, e.g. <Kbd>⌘K</Kbd>. */
	hint?: ReactNode;
}

/** Inset search field: leading magnifier, Esc clears (then bubbles when already empty), clear button when filled. */
export function SearchInput({
	value,
	onValueChange,
	size = "md",
	hint,
	placeholder = "Search",
	disabled,
	className,
	onKeyDown,
	ref,
	...rest
}: SearchInputProps) {
	const inner = useRef<HTMLInputElement>(null);
	useImperativeHandle(ref, () => inner.current as HTMLInputElement);
	const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
		onKeyDown?.(event);
		if (event.defaultPrevented) return;
		if (event.key === "Escape" && value) {
			event.preventDefault();
			event.stopPropagation();
			onValueChange("");
		}
	};
	return (
		<div className={cn(boxClass(false, disabled), "bg-inset", boxSizes[size], className)}>
			<Search aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
			<input
				ref={inner}
				type="search"
				value={value}
				placeholder={placeholder}
				disabled={disabled}
				onChange={(event) => onValueChange(event.currentTarget.value)}
				onKeyDown={handleKey}
				className={cn(innerControl, "[&::-webkit-search-cancel-button]:appearance-none")}
				{...rest}
			/>
			{value ? (
				<button
					type="button"
					aria-label="Clear search"
					onClick={() => {
						onValueChange("");
						inner.current?.focus();
					}}
					className={cn(
						"-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-faint hover:bg-hover hover:text-fg",
						focusRing,
					)}
				>
					<X className="size-3.5" aria-hidden />
				</button>
			) : (
				hint && <span className="inline-flex shrink-0 items-center">{hint}</span>
			)}
		</div>
	);
}

export interface TextareaProps extends ComponentPropsWithRef<"textarea">, FieldTextProps {
	/** Height grows with content between these row counts. */
	minRows?: number;
	maxRows?: number;
}

export function Textarea({
	minRows = 2,
	maxRows = 8,
	label,
	description,
	error,
	id,
	disabled,
	className,
	value,
	onInput,
	ref,
	"aria-describedby": ariaDescribedBy,
	...rest
}: TextareaProps) {
	const ids = useFieldIds(id, { description, error }, ariaDescribedBy);
	const inner = useRef<HTMLTextAreaElement>(null);
	useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement);

	const fit = useCallback(() => {
		const el = inner.current;
		if (!el) return;
		const cs = getComputedStyle(el);
		const line = Number.parseFloat(cs.lineHeight);
		const pad = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
		const border = Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth);
		const min = line * minRows + pad + border;
		const max = line * maxRows + pad + border;
		el.style.height = "auto";
		const wanted = el.scrollHeight + border;
		el.style.height = `${Math.min(Math.max(wanted, min), max)}px`;
		el.style.overflowY = wanted > max ? "auto" : "hidden";
	}, [minRows, maxRows]);

	useLayoutEffect(fit, [fit, value]);

	return (
		<FieldShell {...ids} label={label} description={description} error={error} className={className}>
			<textarea
				ref={inner}
				id={ids.controlId}
				value={value}
				rows={minRows}
				disabled={disabled}
				aria-invalid={error ? true : undefined}
				aria-describedby={ids.describedBy}
				onInput={(event) => {
					fit();
					onInput?.(event);
				}}
				className={cn(
					boxClass(Boolean(error), disabled),
					"block w-full resize-none bg-panel px-2.5 py-1.5 text-md leading-5 outline-none placeholder:text-fg-faint",
					"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
					!error && "focus:border-ring",
				)}
				{...rest}
			/>
		</FieldShell>
	);
}
