/** Display parsing follows omp's utils/title-card.ts (MIT). Stored titles stay unchanged. */
export interface CardTitleParts {
	icon: string;
	code: string;
	title: string;
}

const CARD_LINE = /^(\S+) ([A-Z0-9]{1,6}): (\S.*)$/u;
const MAX_ICON_CODEPOINTS = 8;

/** omp accepts 1-8 non-ASCII codepoints, including complete emoji sequences. */
export function splitCardTitle(title: string): CardTitleParts | undefined {
	const line = CARD_LINE.exec(title);
	if (!line) return undefined;
	let codepoints = 0;
	for (const char of line[1]!) {
		if (char.charCodeAt(0) < 0x80 || ++codepoints > MAX_ICON_CODEPOINTS) return undefined;
	}
	if (codepoints === 0) return undefined;
	return { icon: line[1]!, code: line[2]!, title: line[3]! };
}

/** Strip all Unicode private-use planes, where Nerd Fonts assigns terminal-only glyphs. */
export function stripPrivateUseGlyphs(text: string): string {
	return text.replace(/\p{Co}[\uFE0E\uFE0F]?/gu, "");
}

/** Text-only labels (tooltips, accessibility and native notifications) retain the card code. */
export function sessionTitleText(title: string): string {
	return stripPrivateUseGlyphs(title).trim();
}
