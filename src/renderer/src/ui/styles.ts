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

/*
 * Menu anatomy (DESIGN §5.5): one container and one row for every menu-like surface (dropdown and context menus,
 * select lists, comboboxes, mention lists, pickers, filter pill menus). Concentric radii: the 12px container with a
 * 6px inset holds 6px rows.
 */

/** Floating surface used by menus, popovers, select lists (12px radius). Rendered in the tooltip layer so it stacks above
 * dialogs/sheets. Portalled to <body>, so it always takes the sheet palette, even when its trigger sits on the ink chrome. */
export const floatingSurface =
	"vo-pop rounded-lg border border-border bg-overlay text-fg shadow-(--shadow-pop) outline-none z-(--z-tooltip)";

/** Menu container: the floating surface with the 6px menu inset. Use for any list that floats (Radix or not). */
export const menuContent = `${floatingSurface} p-menu`;

/** Menu / select row: 32px, 8px side padding, 16px icon or check slot first, shortcut last. Radix rows highlight via
 * `data-highlighted`; a hand-driven listbox adds `menuItemActive` to its active option. */
export const menuItem = [
	"relative flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-sm px-row text-left text-md text-fg",
	"transition-colors duration-(--dur-fast) ease-(--ease-out) data-highlighted:bg-selected",
	focusRingInset,
	disabledData,
].join(" ");

/** Highlight for the active option of a listbox that is not a Radix menu (combobox, mention list). */
export const menuItemActive = "bg-selected";

/** A row with a second line: 44px minimum, top-aligned, the icon or check level with the label. */
export const menuItemDescribed = "min-h-11 items-start py-1.5 [&>span:first-child]:mt-px";

export const menuItemDanger = "text-err data-highlighted:bg-err-bg";

/** Leading 16px slot for the selected item's check (or the row's icon) so labels align down the list. */
export const menuCheckSlot = "inline-flex size-4 shrink-0 items-center justify-center text-fg";

/** Leading 16px icon in muted ink. */
export const menuIcon = "inline-flex size-4 shrink-0 text-fg-muted [&>svg]:size-4";

/** Second line of a described row: 12px muted, wraps. */
export const menuDescription = "text-sm text-fg-muted";

/** Group label inside menus and select lists: 11px semibold, sentence case. */
export const menuLabel = "px-row pb-1 pt-1.5 text-xs font-semibold text-fg-faint";

export const menuSeparator = "-mx-menu my-menu h-px bg-border";

export const menuShortcut = "ml-auto pl-4 font-mono text-xs text-fg-faint";
