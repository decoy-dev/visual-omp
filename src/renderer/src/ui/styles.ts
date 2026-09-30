/** Shared class fragments so every primitive draws focus, disabled, and floating surfaces the same way. */

/** 2px `--ring` outline, offset 2, keyboard focus only. */
export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Inset variant for items living inside clipped containers (menu rows, list options). */
export const focusRingInset = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/** 45% opacity + not-allowed, for native `disabled`. */
export const disabledNative = "disabled:cursor-not-allowed disabled:opacity-45";

/** Same treatment for Radix `data-disabled`. */
export const disabledData = "data-disabled:cursor-not-allowed data-disabled:opacity-45";

/** Floating surface used by menus, popovers, select lists. Rendered in the tooltip layer so it stacks above dialogs/sheets. */
export const floatingSurface =
	"vo-pop rounded-md border border-border bg-raised text-fg shadow-(--shadow-pop) outline-none z-(--z-tooltip)";

/** Menu / select row. */
export const menuItem = [
	"relative flex h-[30px] w-full cursor-default select-none items-center gap-2 rounded-sm px-2 text-md text-fg",
	"data-highlighted:bg-selected",
	focusRingInset,
	disabledData,
].join(" ");

export const menuItemDanger = "text-err data-highlighted:bg-err-bg";

export const menuLabel = "px-2 pb-1 pt-1.5 font-mono text-xs uppercase tracking-[0.12em] text-fg-faint";

export const menuSeparator = "-mx-1 my-1 h-px bg-border";

export const menuShortcut = "ml-auto pl-4 font-mono text-xs text-fg-faint";
