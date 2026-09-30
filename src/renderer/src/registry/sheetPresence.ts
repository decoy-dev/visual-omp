/**
 * Exit animations for registry sheets. `SheetHost` (shell/Shell.tsx) keeps a closing sheet mounted with `open`
 * false until the sheet reports that its content has left, then clears it. A sheet opts in by calling
 * `useSheetPresence()`, binding Radix `open` to `open` and calling `exited` from the content's `onCloseAutoFocus`
 * (Radix fires it once the exit animation has finished and the content unmounts). The host then drops the sheet and
 * returns focus to the element that had it when the sheet opened, since sheets open without a Radix trigger.
 * Sheets that don't call the hook are unmounted as soon as they close, as before.
 */
import { createContext, useContext, useLayoutEffect } from "react";

export interface SheetPresence {
	/** False while the sheet plays its exit. */
	open: boolean;
	/** The content has unmounted; the host may drop the sheet. */
	exited(): void;
	/** Called by `useSheetPresence` so the host knows to wait for `exited`. */
	claim(): void;
}

/** Outside a sheet host: always open, and nothing to report. */
export const SheetPresenceContext = createContext<SheetPresence>({ open: true, exited() {}, claim() {} });

export function useSheetPresence(): { open: boolean; exited(): void } {
	const presence = useContext(SheetPresenceContext);
	useLayoutEffect(() => presence.claim(), [presence]);
	return presence;
}
