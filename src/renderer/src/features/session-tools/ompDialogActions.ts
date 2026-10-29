/**
 * Answering omp's in-place dialogs (`ompDialog.ts`) with keys, each step verified on the painted
 * screen: a choice moves omp's highlight until the screen shows it on the option and then presses
 * Enter; a text answer replaces the field's text and presses the submit key omp's legend names;
 * cancelling presses omp's cancel key.
 */
import { i18n } from "../../i18n";
import type { SessionController } from "../../state/session";
import { press, readScreen, waitForScreen } from "./drive";
import { dialogKey, type OmpDialog, type OmpSelectDialog, type OmpTextDialog, parseOmpDialog } from "./ompDialog";

/** Pairs of "delete to line start, join with the line above" per clearing round of the editor. */
const CLEAR_LINES = 40;

/** Whether `next` is still the dialog the card shows (same kind and title). */
function isSame<T extends OmpDialog>(dialog: T, next: OmpDialog | null): next is T {
	return next !== null && next.kind === dialog.kind && next.title === dialog.title;
}

/** Move omp's highlight onto option `index` of `dialog`, then confirm it with Enter. */
export async function chooseOption(session: SessionController, dialog: OmpSelectDialog, index: number): Promise<void> {
	const label = dialog.options[index]?.label;
	if (label === undefined) return;
	// Labels can repeat, so the target is the n-th option with this label.
	const occurrence = dialog.options.slice(0, index).filter(option => option.label === label).length;
	for (let step = 0; step < 12; step++) {
		const current = parseOmpDialog(await readScreen(session));
		if (!isSame(dialog, current)) throw new Error(i18n.t("session:ompDialog.errors.closed"));
		const target = current.options.findIndex(
			(option, at) => option.label === label && current.options.slice(0, at).filter(other => other.label === label).length === occurrence,
		);
		if (target < 0) throw new Error(i18n.t("session:ompDialog.errors.missing"));
		if (target === current.selected) {
			const key = dialogKey(current);
			await press(session, "enter");
			const closed = await waitForScreen(session, lines => {
				const next = parseOmpDialog(lines);
				return next === null || dialogKey(next) !== key;
			});
			if (!closed) throw new Error(i18n.t("session:ompDialog.errors.notAccepted"));
			return;
		}
		const distance = target - current.selected;
		await press(session, Array.from({ length: Math.abs(distance) }, () => (distance > 0 ? "down" : "up")).join(" "));
		await waitForScreen(
			session,
			lines => {
				const next = parseOmpDialog(lines);
				return !isSame(dialog, next) || next.selected !== current.selected;
			},
			1500,
		);
	}
	throw new Error(i18n.t("session:ompDialog.errors.unreachable"));
}

/** Replace the field's text with `text` and press omp's submit key. */
export async function submitText(session: SessionController, dialog: OmpTextDialog, text: string): Promise<void> {
	const hostId = session.hostId;
	const current = parseOmpDialog(await readScreen(session));
	if (!hostId || !isSame(dialog, current)) throw new Error(i18n.t("session:ompDialog.errors.closed"));
	if (current.value !== text.trim()) {
		if (current.value !== "") {
			const clear =
				dialog.kind === "input" ? "end C-u" : `pagedown pagedown end ${Array.from({ length: CLEAR_LINES }, () => "C-u backspace").join(" ")}`;
			let cleared: string[] | null = null;
			for (let round = 0; round < 3 && !cleared; round++) {
				await session.keys(clear);
				cleared = await waitForScreen(
					session,
					lines => {
						const next = parseOmpDialog(lines);
						return isSame(dialog, next) && next.value === "";
					},
					1500,
				);
			}
			if (!cleared) throw new Error(i18n.t("session:ompDialog.errors.clear"));
		}
		if (text.trim() !== "") {
			// One bracketed paste, so newlines in an editor answer arrive as text instead of keys.
			await window.vomp.invoke("host:paste", hostId, text);
			const typed = await waitForScreen(session, lines => {
				const next = parseOmpDialog(lines);
				return isSame(dialog, next) && next.value !== "";
			});
			if (!typed) throw new Error(i18n.t("session:ompDialog.errors.typed"));
		}
	}
	await press(session, current.submitKey);
	// omp can keep the dialog open to show a validation error; the card then stays for another try.
	await waitForScreen(session, lines => !isSame(dialog, parseOmpDialog(lines)), 3000);
}

/** Press omp's cancel key and wait for the dialog to close. */
export async function cancelDialog(session: SessionController, dialog: OmpDialog): Promise<void> {
	const key = dialogKey(dialog);
	await press(session, dialog.cancelKey);
	const closed = await waitForScreen(session, lines => {
		const next = parseOmpDialog(lines);
		return next === null || dialogKey(next) !== key;
	});
	if (!closed) throw new Error(i18n.t("session:ompDialog.errors.notCancelled"));
}
