/** Shared class fragments so every primitive draws focus, disabled, press and floating surfaces the same way. */

/** 2px `--ring` outline, offset 2, keyboard focus only. */
export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Inset variant for items living inside clipped containers (menu rows, list options). */
export const focusRingInset = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/** 45% opacity + not-allowed, for native `disabled`. */
export const disabledNative = "disabled:cursor-not-allowed disabled:opacity-45";

/** Same treatment for Radix `data-disabled`. */
export const disabledData = "data-disabled:cursor-not-allowed data-disabled:opacity-45";

/** Press feedback for small square controls (close buttons, chip remove): a slightly deeper scale than Button. */
export const pressSmall = "active:scale-[0.94]";

/** Corner close button shared by Dialog, Sheet and Toaster. */
export const closeButton = [
	"inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted",
	"transition-[background-color,color,scale] duration-(--dur-fast) ease-(--ease-out-quart) hover:bg-hover hover:text-fg",
	pressSmall,
	focusRing,
].join(" ");

/** Floating surface used by menus, popovers, select lists. Rendered in the tooltip layer so it stacks above dialogs/sheets. */
export const floatingSurface =
	"vo-pop rounded-md border border-border bg-raised text-fg shadow-(--shadow-pop) outline-none z-(--z-tooltip)";

/** Menu / select row. */
export const menuItem = [
	"relative flex h-[30px] w-full cursor-default select-none items-center gap-2 rounded-sm px-2 text-md text-fg",
	"transition-colors duration-(--dur-fast) ease-(--ease-out) data-highlighted:bg-selected",
	focusRingInset,
	disabledData,
].join(" ");

export const menuItemDanger = "text-err data-highlighted:bg-err-bg";

/** Group label inside menus and select lists: sentence case, like `.section-label`. */
export const menuLabel = "px-2 pb-1 pt-1.5 text-sm font-medium text-fg-muted";

export const menuSeparator = "-mx-1 my-1 h-px bg-border";

export const menuShortcut = "ml-auto pl-4 font-mono text-xs text-fg-faint";
