/** Self-contained for the trusted extension. Only owned leading image markers may precede authored text. */
export function expandedPromptTextMatches(text: string, expected: string, images = 0): boolean {
	if (text === expected) return true;
	if (!Number.isSafeInteger(images) || images < 1) return false;
	let authored = text.trimStart();
	for (let index = 1; index <= images; index++) {
		const marker = /^\[Image #([1-9]\d*)(?:, [1-9]\d*x[1-9]\d*)?\]/.exec(authored);
		if (!marker || marker[1] !== String(index)) return false;
		authored = authored.slice(marker[0].length).trimStart();
	}
	return authored === expected;
}
