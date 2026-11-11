/** Pieces shared by the per-request question card and the question series card (DESIGN §4.8). */
import { Check } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { cn, spring } from "../../ui";
import { ColorText } from "../../transcript/ColorText";

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
	disabled?: boolean;
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
	/** Render backtick-delimited code from model-authored question text. */
	inlineCode?: boolean;
}

/** Bordered option tiles in a two-column grid: a radio group with arrow keys, or a group of checkboxes. */
export function ChoiceGrid({ choices, multi, labelledBy, describedBy, isOn, activeIndex, onSelect, onConfirm, disabled = false, inlineCode = false }: ChoiceGridProps): ReactNode {
	const indicatorId = useId();
	const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
		// Modified arrows belong to the card (Alt+Left and Alt+Right move between questions).
		if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
		const current = Number((event.target as HTMLElement).dataset.choice ?? activeIndex);
		const direction = event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "Home" ? 1
			: event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "End" ? -1 : 0;
		if (!direction) return;
		event.preventDefault();
		let next = event.key === "Home" ? -1 : event.key === "End" ? choices.length : current < 0 ? direction === 1 ? -1 : choices.length : current;
		for (let step = 0; step < choices.length; step++) {
			next = (next + direction + choices.length) % choices.length;
			if (!choices[next]?.disabled) {
				onSelect(next);
				event.currentTarget.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus({ preventScroll: true });
				return;
			}
		}
	};
	const tabIndex = choices[activeIndex] && !choices[activeIndex]?.disabled ? activeIndex : choices.findIndex(choice => !choice.disabled);

	return (
		<div
			role={multi ? "group" : "radiogroup"}
			aria-labelledby={labelledBy}
			aria-describedby={describedBy}
			onKeyDown={multi || disabled ? undefined : moveSelection}
			className="mt-3 grid gap-2 sm:grid-cols-2"
		>
			{choices.map(({ label, description, disabled: optionDisabled }, index) => {
				const on = isOn(index);
				// Radio pattern: only the checked option (or the first) is a tab stop; arrow keys move and select.
				const tabStop = !optionDisabled && (multi || index === tabIndex);
				return (
					<button
						// Options are fixed per question, and their labels can repeat.
						key={index}
						type="button"
						role={multi ? "checkbox" : "radio"}
						aria-checked={on}
						tabIndex={tabStop ? 0 : -1}
						disabled={disabled || optionDisabled}
						aria-disabled={disabled || optionDisabled || undefined}
						data-choice={index}
						onClick={() => { if (!disabled && !optionDisabled) onSelect(index); }}
						onDoubleClick={() => {
							if (!multi && !disabled && !optionDisabled) onConfirm?.(index);
						}}
						className={cn(
							"relative flex min-h-12 items-start gap-2.5 rounded-md border px-3 py-2.5 text-left outline-none transition-colors duration-(--dur) focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default",
							on ? "border-transparent" : "border-control enabled:hover:bg-hover",
							multi && on && "border-accent bg-accent-muted",
							(disabled || optionDisabled) && !on && "opacity-60",
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
							<span className="block text-md font-medium text-fg"><ColorText text={label} inlineCode={inlineCode} /></span>
							{description && <span className="mt-0.5 block text-sm text-fg-muted"><ColorText text={description} inlineCode={inlineCode} /></span>}
						</span>
					</button>
				);
			})}
		</div>
	);
}
