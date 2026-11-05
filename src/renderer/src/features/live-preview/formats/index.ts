import type { LiveAdapter, LiveFormat } from "../types";

/** Each format has its own import boundary, including the lightweight request card. */
export async function loadAdapter(format: LiveFormat): Promise<LiveAdapter> {
	switch (format) {
		case "svg": return (await import("./svg")).adapter;
		case "mermaid": return (await import("./mermaid")).adapter;
		case "markdown": return (await import("./markdown")).adapter;
		case "csv": return (await import("./csv")).adapter;
		case "html": return (await import("./html")).adapter;
		case "image": return (await import("./image")).adapter;
		case "pdf": return (await import("./pdf")).adapter;
		case "video": return (await import("./video")).adapter;
		case "sequence": return (await import("./sequence")).adapter;
		case "generate-image": return (await import("./generate-image")).adapter;
		case "result-images": return (await import("./result-images")).adapter;
	}
}
