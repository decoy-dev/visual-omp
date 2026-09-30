import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef } from "react";
import { cn } from "../ui";

interface ResizeHandleProps {
	label: string;
	/** Current size in px of the panel this handle resizes. */
	value: number;
	min: number;
	max: number;
	/** +1 when dragging right grows the panel (left sidebar), -1 when it shrinks it (right dock). */
	direction: 1 | -1;
	onChange(value: number): void;
}

/** 4px vertical splitter: pointer drag, and arrow keys for keyboard users (WAI-ARIA separator). */
export function ResizeHandle({ label, value, min, max, direction, onChange }: ResizeHandleProps): ReactNode {
	const start = useRef<{ x: number; value: number } | null>(null);

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		event.currentTarget.setPointerCapture(event.pointerId);
		start.current = { x: event.clientX, value };
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (!start.current) return;
		onChange(Math.min(max, Math.max(min, start.current.value + (event.clientX - start.current.x) * direction)));
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? 48 : 16;
		if (event.key === "ArrowLeft") onChange(Math.max(min, Math.min(max, value - step * direction)));
		else if (event.key === "ArrowRight") onChange(Math.max(min, Math.min(max, value + step * direction)));
		else return;
		event.preventDefault();
	};

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={Math.round(value)}
			aria-valuemin={min}
			aria-valuemax={max}
			tabIndex={0}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={() => {
				start.current = null;
			}}
			onKeyDown={onKeyDown}
			className={cn(
				"group relative z-(--z-sticky) -mx-0.5 w-1 shrink-0 cursor-col-resize outline-none",
				"after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-(--dur-fast)",
				"hover:after:bg-accent focus-visible:after:bg-ring",
			)}
		/>
	);
}
