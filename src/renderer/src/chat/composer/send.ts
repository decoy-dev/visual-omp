/**
 * Turning a composer draft into what omp's own editor receives.
 *
 * - Shell / Python modes prefix the text exactly like typing in omp: `!cmd` runs a shell command,
 *   `$ code` runs Python (the sigil needs a space after it, input-controller.ts).
 * - Images travel the way a terminal delivers a file drag: one bracketed paste made only of absolute
 *   image paths makes omp's editor attach them (custom-editor.ts accepts png/jpg/jpeg/gif/webp; spaces
 *   and shell metacharacters backslash-escaped). The message text follows in the same write, then
 *   Enter; omp holds keys that arrive after an attaching paste until the images are loaded.
 */
import type { SessionController } from "../../state/session";
import type { Attachment, ComposerMode } from "./drafts";

/** Extensions omp's editor attaches from a pasted path. */
export const ATTACHABLE_IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;

/** Characters omp un-escapes in pasted paths (`SHELL_ESCAPED_PATH_CHAR_REGEX`). */
const SHELL_SPECIAL = /[\\\s'"()[\]{}&;<>|?*!$`]/g;

export function applyMode(text: string, mode: ComposerMode | null): string {
	const trimmed = text.trim();
	if (!mode || !trimmed) return trimmed;
	if (mode === "shell") return trimmed.startsWith("!") ? trimmed : `!${trimmed}`;
	return /^\$\$?(\s|$)/.test(trimmed) ? trimmed : `$ ${trimmed}`;
}

/** The bracketed paste that attaches `paths` in omp's editor. */
export function imagePaste(paths: readonly string[]): string {
	return `\x1b[200~${paths.map(path => path.replace(SHELL_SPECIAL, "\\$&")).join(" ")}\x1b[201~`;
}

/** Absolute image paths for omp's bracketed-paste path detector (before escaping). */
export function imagePathsText(paths: readonly string[]): string {
	return paths.map(path => path.replace(SHELL_SPECIAL, "\\$&")).join(" ");
}

/** Everything written by a terminal for one message with images: attach, type, submit. */
export function imageMessageBytes(paths: readonly string[], text: string): string {
	// An empty bracketed paste means "paste the clipboard image" to omp, so skip it for image-only messages.
	return `${imagePaste(paths)}${text ? `\x1b[200~${text}\x1b[201~` : ""}\r`;
}

/**
 * Send a composed message. Text-only messages go through the chat's queue (they wait while omp works);
 * `now` steers the running turn instead. Messages with images are delivered at once — omp itself holds
 * a message typed mid-turn until its next step — because attachments must travel with their text.
 */
export async function deliver(
	session: SessionController,
	text: string,
	images: readonly Attachment[],
	now: boolean,
): Promise<void> {
	if (images.length === 0) {
		if (now && session.getSnapshot().working) await session.command(text);
		else await session.send(text);
		return;
	}
	// The paste goes around the controller's queue, so record the send before waiting for omp.
	session.markInput();
	await session.whenLive();
	const hostId = session.hostId;
	if (!hostId) throw new Error("omp is not running");
	await window.vomp.invoke("composer:paste", hostId, imagePathsText(images.map(image => image.path)));
	if (text) await session.command(text);
}
