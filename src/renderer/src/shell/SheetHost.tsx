/** The registry sheet host: the open sheet, its exit, and its failure state when it does not load. */
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadBoundary, type LoadFailureProps } from "../registry/lazy";
import { type SheetPresence, SheetPresenceContext, useSheetPresence } from "../registry/sheetPresence";
import { sheets } from "../registry/slots";
import { useApp } from "../state/app";
import { Button, Dialog, DialogContent } from "../ui";

/** Longest a sheet that plays an exit may take to report it before the host drops it anyway. */
const SHEET_EXIT_MAX_MS = 1000;

/**
 * Renders the open sheet. A closed sheet that uses `useSheetPresence` stays mounted with `open` false until it
 * reports its exit finished (see registry/sheetPresence.ts); any other sheet unmounts as soon as it closes.
 * A sheet whose chunk or deferred text does not load shows `SheetLoadFailed` instead.
 */
export function SheetHost(): ReactNode {
	const sheet = useApp(state => state.sheet);
	const list = sheets.use();
	// The sheet on screen: the open one, or the last one while it plays its exit.
	const [shown, setShown] = useState(sheet);
	// What had focus before the sheet opened. Sheets open without a Radix trigger, so the host returns focus itself.
	const opener = useRef<HTMLElement | null>(null);
	if (sheet && sheet !== shown) {
		if (!shown) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setShown(sheet);
	}
	const current = sheet ?? shown;
	const open = sheet !== null;
	const id = current?.id ?? null;
	const claimedBy = useRef<string | null>(null);

	useEffect(() => {
		if (open || !id) return;
		if (claimedBy.current !== id) {
			setShown(null);
			return;
		}
		const timer = setTimeout(() => setShown(null), SHEET_EXIT_MAX_MS);
		return () => clearTimeout(timer);
	}, [open, id]);

	const presence = useMemo<SheetPresence>(
		() => ({
			open,
			// Reopening during the exit keeps the sheet; only a sheet that stayed closed is dropped.
			exited: () => {
				if (useApp.getState().sheet) return;
				setShown(null);
				if (opener.current?.isConnected) opener.current.focus();
				opener.current = null;
			},
			claim: () => {
				claimedBy.current = id;
			},
		}),
		[open, id],
	);

	if (!current) return null;
	const spec = list.find(entry => entry.id === current.id);
	if (!spec) return null;
	const Component = spec.component;
	const close = () => useApp.getState().closeSheet();
	// Sheet props are defined by each feature; the opener passes the matching shape.
	return (
		<SheetPresenceContext.Provider value={presence}>
			<LoadBoundary key={current.id} fallback={retry => <SheetLoadFailed retry={retry} close={close} />}>
				<Component props={current.props as never} close={close} />
			</LoadBoundary>
		</SheetPresenceContext.Provider>
	);
}

/**
 * A sheet that did not load: a small dialog with Try again and Close. It takes part in sheet presence like any
 * sheet, so closing it plays its exit and returns focus to the opener, even when the failed sheet had claimed
 * presence before a nested part of it failed.
 */
function SheetLoadFailed({ retry, close }: LoadFailureProps & { close(): void }): ReactNode {
	const { t } = useTranslation("shell");
	const presence = useSheetPresence();
	return (
		<Dialog open={presence.open} onOpenChange={open => !open && close()}>
			<DialogContent
				onCloseAutoFocus={presence.exited}
				size="sm"
				title={t("load.failedTitle")}
				description={t("load.failedBody")}
				footer={
					<>
						<Button variant="ghost" onClick={close}>
							{t("load.close")}
						</Button>
						<Button variant="primary" onClick={retry}>
							{t("load.retry")}
						</Button>
					</>
				}
			/>
		</Dialog>
	);
}

