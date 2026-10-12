/** Pieces shared by the per-request question card and the question series card (DESIGN §4.8). */
import { Check } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { cn, spring } from "../../ui";

export const cardClass = "rounded-lg border border-border bg-panel p-4 shadow-(--shadow-card)";

export const otherInputClass =
	"mt-2 h-9 w-full rounded-md border border-control bg-panel px-3 text-md text-fg transition-colors duration-(--dur) placeholder:text-fg-faint hover:border-fg-muted focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60";

/** The question itself, led by a glyph that says who is asking and why. */
export function Heading({ icon, children }: { icon: ReactNode; children: ReactNode }): ReactNode {
	return (
		<div className="flex items-start gap-2.5">
			<span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center [&>svg]:size-4.5" aria-hidden>
				{icon}
			</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

export interface Choice {
	label: string;
	description?: string;
}

export interface ChoiceGridProps {
	choices: readonly Choice[];
	multi: boolean;
	labelledBy: string;
	/** Extra context for the group, such as the series progress. */
	describedBy?: string;
	/** Whether option `index` is checked (multiple choice) or picked (single choice). */
	isOn: (index: number) => boolean;
	/** Single choice: the picked option, or -1 when none is (a typed "Other" answer, say). */
	activeIndex: number;
	/** Single choice: pick the option. Multiple choice: toggle it. */
	onSelect: (index: number) => void;
	/** Single choice: a double-click answers with the option at once. */
	onConfirm?: (index: number) => void;
	disabled?: boolean;
}

/** Bordered option tiles in a two-column grid: a radio group with arrow keys, or a group of checkboxes. */
export function ChoiceGrid({ choices, multi, labelledBy, describedBy, isOn, activeIndex, onSelect, onConfirm, disabled = false }: ChoiceGridProps): ReactNode {
	const indicatorId = useId();
	const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
		// Modified arrows belong to the card (Alt+Left and Alt+Right move between questions).
		if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
		const current = Number((event.target as HTMLElement).dataset.choice ?? activeIndex);
		const last = choices.length - 1;
		const next =
			event.key === "ArrowDown" || event.key === "ArrowRight"
				? current >= last ? 0 : current + 1
				: event.key === "ArrowUp" || event.key === "ArrowLeft"
					? current <= 0 ? last : current - 1
					: event.key === "Home"
						? 0
						: event.key === "End"
							? last
							: null;
		if (next === null) return;
		event.preventDefault();
		onSelect(next);
		event.currentTarget.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus();
	};

	return (
		<div
			role={multi ? "group" : "radiogroup"}
			aria-labelledby={labelledBy}
			aria-describedby={describedBy}
			onKeyDown={multi || disabled ? undefined : moveSelection}
			className="mt-3 grid gap-2 sm:grid-cols-2"
		>
			{choices.map(({ label, description }, index) => {
				const on = isOn(index);
				// Radio pattern: only the checked option (or the first) is a tab stop; arrow keys move and select.
				const tabStop = multi || (activeIndex === -1 ? index === 0 : index === activeIndex);
				return (
					<button
						// Options are fixed per question, and their labels can repeat.
						key={index}
						type="button"
						role={multi ? "checkbox" : "radio"}
						aria-checked={on}
						tabIndex={tabStop ? 0 : -1}
						disabled={disabled}
						data-choice={index}
						onClick={() => onSelect(index)}
						onDoubleClick={() => {
							if (!multi) onConfirm?.(index);
						}}
						className={cn(
							"relative flex min-h-12 items-start gap-2.5 rounded-md border px-3 py-2.5 text-left outline-none transition-colors duration-(--dur) focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default",
							on ? "border-transparent" : "border-control enabled:hover:bg-hover",
							multi && on && "border-accent bg-accent-muted",
							disabled && !on && "opacity-60",
						)}
					>
						{/* Single choice: one highlight slides to the picked option. */}
						{!multi && on && (
							<motion.span
								layoutId={indicatorId}
								aria-hidden
								transition={spring.snappy}
								className="absolute -inset-px rounded-md border border-accent bg-accent-muted"
							/>
						)}
						<span
							className={cn(
								"relative mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors duration-(--dur)",
								multi ? "rounded-sm" : "rounded-full",
								on ? "border-accent bg-accent text-accent-fg" : "border-control bg-panel",
							)}
							aria-hidden
						>
							<AnimatePresence initial={false}>
								{on && (
									<motion.span
										key="mark"
										initial={{ scale: 0.4, opacity: 0 }}
										animate={{ scale: 1, opacity: 1 }}
										exit={{ scale: 0.4, opacity: 0 }}
										transition={spring.snappy}
										className="inline-flex"
									>
										{multi ? <Check weight="bold" className="size-3" /> : <span className="size-1.5 rounded-full bg-accent-fg" />}
									</motion.span>
								)}
							</AnimatePresence>
						</span>
						<span className="relative min-w-0 wrap-anywhere">
							<span className="block text-md font-medium text-fg">{label}</span>
							{description && <span className="mt-0.5 block text-sm text-fg-muted">{description}</span>}
						</span>
					</button>
				);
			})}
		</div>
	);
}
