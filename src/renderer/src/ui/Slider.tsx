import * as RS from "@radix-ui/react-slider";
import { useEffect, useState } from "react";
import { cn } from "./cn";
import { disabledData, focusRing } from "./styles";

export interface SliderProps {
	value: number;
	onValueChange: (value: number) => void;
	/** Fires once when the user releases (pointer up / key). */
	onValueCommit?: (value: number) => void;
	min?: number;
	max?: number;
	step?: number;
	/** Accessible name (the slider has no visible label of its own). */
	"aria-label": string;
	/** Bubble + aria-valuetext formatting, e.g. v => `${v}%`. */
	formatValue?: (value: number) => string;
	disabled?: boolean;
	className?: string;
}

/** 4px track, 16px thumb (24px hit area); a mono value bubble floats above the thumb while dragging or keyboard-focused. */
export function Slider({
	value,
	onValueChange,
	onValueCommit,
	min = 0,
	max = 100,
	step = 1,
	formatValue = String,
	disabled,
	className,
	...aria
}: SliderProps) {
	const [dragging, setDragging] = useState(false);
	useEffect(() => {
		if (!dragging) return;
		const stop = () => setDragging(false);
		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
		return () => {
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
		};
	}, [dragging]);

	const text = formatValue(value);
	return (
		<RS.Root
			value={[value]}
			min={min}
			max={max}
			step={step}
			disabled={disabled}
			onValueChange={([next]) => {
				if (next !== undefined) onValueChange(next);
			}}
			onValueCommit={([next]) => {
				if (next !== undefined) onValueCommit?.(next);
			}}
			onPointerDown={() => setDragging(true)}
			className={cn(
				"relative flex h-6 w-full touch-none select-none items-center",
				disabledData,
				className,
			)}
		>
			<RS.Track className="relative h-1 grow overflow-hidden rounded-full bg-control">
				<RS.Range className="absolute h-full rounded-full bg-accent" />
			</RS.Track>
			<RS.Thumb
				aria-label={aria["aria-label"]}
				aria-valuetext={text}
				className={cn(
					"group relative block size-4 rounded-full border-2 border-accent bg-panel shadow-(--shadow-card)",
					"transition-[scale] duration-(--dur-fast) ease-(--ease-spring) hover:scale-110",
					"before:absolute before:-inset-1 before:rounded-full before:content-['']",
					focusRing,
				)}
			>
				<span
					aria-hidden
					className={cn(
						"pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-fg px-1.5 py-0.5 font-mono text-xs text-fg-inverse shadow-(--shadow-pop)",
						"transition-opacity duration-(--dur-fast)",
						dragging ? "opacity-100" : "opacity-0 group-focus-visible:opacity-100",
					)}
				>
					{text}
				</span>
			</RS.Thumb>
		</RS.Root>
	);
}
