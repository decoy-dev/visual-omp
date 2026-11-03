import type { EditorDraftResult } from "@shared/contracts/composer";

interface ClassicImageInput {
	assertCurrent(): void;
	readEditor(): Promise<EditorDraftResult>;
	restoreEditor(expected: string, original: string): Promise<EditorDraftResult>;
	failureText(): Promise<string | null>;
	paste(text: string): void;
	wait(): Promise<void>;
}

function insertedImageToken(before: string, after: string, symbol: string | undefined): boolean {
	if (!symbol) return false;
	const prefix = `${symbol} #`;
	for (let offset = after.indexOf(prefix); offset >= 0; offset = after.indexOf(prefix, offset + prefix.length)) {
		const number = /^[1-9]\d* /.exec(after.slice(offset + prefix.length))?.[0];
		if (number && after.slice(0, offset) + after.slice(offset + prefix.length + number.length) === before) return true;
	}
	return false;
}
/** Wait for omp's own attachment tokens before allowing the caller to type its prompt or Enter. */
export async function attachClassicImages(paths: string, input: ClassicImageInput): Promise<void> {
	const encoded = paths.match(/(?:\\[\s\S]|[^\s])+/g) ?? [];
	if (encoded.length === 0) throw new Error("Image attachment paths are required");
	input.assertCurrent();
	const original = await input.readEditor();
	if (original.text === null || original.imageChips === undefined) throw new Error(original.error ?? "omp did not report its image attachments.");
	let current = original;
	let pasted = false;
	try {
		for (const path of encoded) {
			const before = current;
			const beforeFailure = await input.failureText();
			input.assertCurrent();
			input.paste(path);
			pasted = true;
			const deadline = Date.now() + 8000;
			while (true) {
				input.assertCurrent();
				current = await input.readEditor();
				input.assertCurrent();
				if (current.text === null || current.imageChips === undefined) throw new Error(current.error ?? "omp did not report its image attachments.");
				if (current.imageChips === before.imageChips! + 1) {
					if (!insertedImageToken(before.text!, current.text, current.imageSymbol)) throw new Error("omp's editor changed while attaching the image.");
					break;
				}
				const failure = await input.failureText();
				if (failure && (failure !== beforeFailure || current.text !== before.text)) {
					const decoded = path.replace(/\\([\s\S])/g, "$1");
					// A public editor replacement cannot remove pending image payloads. Restore only a text-only failure.
					if (original.imageChips === 0 && current.imageChips === 0 && (current.text === original.text || current.text.replace(decoded, "") === original.text)) {
						input.assertCurrent();
						const restored = await input.restoreEditor(current.text, original.text);
						input.assertCurrent();
						if (restored.restored) throw new Error(`Image submission was restored. ${failure}`);
					}
					throw new Error(failure);
				}
				if (current.imageChips !== before.imageChips || Date.now() >= deadline) throw new Error("omp did not confirm the image attachment.");
				await input.wait();
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Image submission was restored. ")) throw error;
		if (!pasted) throw error;
		throw new Error(`Image submission needs recovery. ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Status text comes from omp's debug components, without parsing the user's editor or transcript. */
export function classicImageFailure(values: Record<string, unknown>): string | null {
	for (const value of Object.values(values)) {
		if (typeof value !== "object" || value === null || !("textPreview" in value) || "cursorLine" in value) continue;
		const text = value.textPreview;
		if (typeof text === "string" && /^(?:Failed to read pasted image path|Pasted path is not a supported image|Unsupported pasted image format:|Image not found at )/.test(text)) return text;
	}
	return null;
}
