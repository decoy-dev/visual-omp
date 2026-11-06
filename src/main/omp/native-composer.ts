import type { ComposerAssist, ComposerAssistRequest } from "@shared/contracts/composer";

/** Serialized into the trusted extension. All parsing, ranking and enablement stay in omp. */
export async function readComposerAssist(
	request: ComposerAssistRequest,
	engine: {
		complete?: (lines: string[], line: number, col: number) => Promise<{ items: { value: string; description?: string }[]; prefix: string } | null>;
		ranges?: (text: string) => { from: number; to: number }[];
		keywords?: readonly { id: string; word: string; description: string }[];
		enabled?: (id?: string) => boolean;
	},
): Promise<ComposerAssist> {
	let keywords: ComposerAssist["keywords"] = [];
	// Verified against omp's keyword registry and notice templates. These describe effects, not settings.
	const effects: Record<string, string> = {
		ultrathink: "Requests maximum automatic thinking and adds instructions for careful, multi-step reasoning.",
		chillax: "Requests the model's lowest thinking effort where supported and adds instructions for brief reasoning.",
		orchestrate: "Adds instructions to delegate substantial work to helpers and verify their results.",
		workflow: "Adds instructions to organize independent work through eval workpools.",
		jevify: "Adds instructions to classify bulk items with eval's batch judge and review flagged results.",
	};
	try {
		if (request.keywords !== false && engine.enabled?.()) {
			for (const range of engine.ranges?.(request.text) ?? []) {
				const keyword = engine.keywords?.find(item => item.word === request.text.slice(range.from, range.to));
				if (keyword && engine.enabled(keyword.id)) keywords.push({
					start: range.from, end: range.to, description: effects[keyword.id] ?? `omp: ${keyword.description}`,
				});
			}
		}
	} catch { keywords = []; } // Optional keyword metadata must never disable model completion.
	let items: ComposerAssist["items"] = null;
	const before = request.text.slice(0, request.cursor);
	// Only ask for model tokens. Other provider branches can walk files or invoke extension logic.
	const prefix = /(?:^|\s)(\^[^\s]*)$/.exec(before)?.[1];
	try {
		if (request.complete && prefix && engine.complete) {
			const lines = request.text.split("\n");
			const prior = before.split("\n");
			const result = await engine.complete(lines, prior.length - 1, prior.at(-1)!.length);
			items = result?.prefix === prefix ? result.items.slice(0, 20).map(item => ({
				value: item.value,
				description: (item.description ?? "").replace(/\x1b\[[0-9;]*m/g, ""),
			})) : [];
		}
	} catch { items = null; } // Preserve valid decorations if completion is temporarily unavailable.
	return { items, keywords };
}
