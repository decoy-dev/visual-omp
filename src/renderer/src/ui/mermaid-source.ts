import { JSON_SCHEMA, load } from "js-yaml";
import { MermaidResourceError } from "./mermaid-policy";

/** Keep diagrams, textual URLs and click/link declarations; forbid source that can fetch during layout. */
export function selfContainedMermaid(source: string): string {
	const prepared = source.replace(/%%\{[\s\S]*?\}%%/g, "").replace(/^\s*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
	if (/<\s*(?:img|image|iframe|object|embed)\b/i.test(prepared) || /!\[[^\]]*\]\s*\(/.test(prepared)) throw new MermaidResourceError();
	// Image-shape metadata can span lines and contain braces inside quoted labels.
	const objects = /@\s*\{/g;
	for (let match = objects.exec(prepared); match; match = objects.exec(prepared)) {
		let quote = "", depth = 1, end = objects.lastIndex;
		for (; end < prepared.length && depth > 0; end++) {
			const character = prepared[end];
			if (quote) {
				if (character === "\\") end++;
				else if (character === quote) quote = "";
			} else if (character === '"' || character === "'") quote = character;
			else if (character === "{") depth++;
			else if (character === "}") depth--;
		}
		if (depth !== 0) throw new Error("Incomplete Mermaid metadata");
		const metadata = prepared.slice(objects.lastIndex, end - 1);
		// Match Mermaid's addVertex metadata decoding, including quoted-key escapes and YAML aliases.
		const yaml = metadata.includes("\n") ? `${metadata}\n` : `{\n${metadata}\n}`;
		const decoded = load(yaml, { schema: JSON_SCHEMA }) as Record<string, unknown> | null | undefined;
		if (decoded && (decoded.img !== undefined || decoded.image !== undefined || decoded.shape === "image")) throw new MermaidResourceError();
		objects.lastIndex = end;
	}
	for (const match of prepared.matchAll(/(?:^|;)\s*(?:style|classDef|linkStyle)\b[^\r\n]*/gmi)) {
		const externalUrl = /\burl\s*\(\s*(?!["']?#[\w:.-]+["']?\s*\))/i.test(match[0]);
		if (externalUrl || /\b(?:image-set|cross-fade)\s*\(|https?:|\/\/|data:|blob:|file:|@import|\\/i.test(match[0])) throw new MermaidResourceError();
	}
	return prepared;
}
