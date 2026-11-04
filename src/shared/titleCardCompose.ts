/** Title composition follows omp's utils/title-card.ts (MIT). Loaded by title-editing dialogs. */
const MAX_ICON_CODEPOINTS = 8;
const CARD_EMOJI = /^\p{RGI_Emoji}$/v;
const CARD_CODE = /^[A-Z0-9]{1,6}$/;

/** Normalize an emoji with omp's presentation-selector and codepoint rules. */
export function normalizeCardIcon(text: string): string | undefined {
	const icon = text.trim();
	if (!icon) return undefined;
	const normalized = CARD_EMOJI.test(icon) ? icon : CARD_EMOJI.test(`${icon}\uFE0F`) ? `${icon}\uFE0F` : undefined;
	if (!normalized) return undefined;
	let codepoints = 0;
	for (const char of normalized) {
		if (char.charCodeAt(0) < 0x80 || ++codepoints > MAX_ICON_CODEPOINTS) return undefined;
	}
	return normalized;
}

/** Compose a title for omp's rename command or saved-session title writer. */
export function composeCardTitle(icon: string, code: string, title: string): string {
	const emoji = normalizeCardIcon(icon);
	const normalizedCode = code.trim().toUpperCase();
	if (!emoji) throw new Error("Choose one emoji for this chat.");
	if (!CARD_CODE.test(normalizedCode)) throw new Error("Use 1-6 letters or digits for the chat code.");
	const name = title.trim();
	if (!name || /[\r\n]/u.test(name)) throw new Error("Use a single-line chat title.");
	return `${emoji} ${normalizedCode}: ${name}`;
}
