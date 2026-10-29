import mermaid from "mermaid";
import { selfContainedMermaid } from "./mermaid-source";

let sequence = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Mermaid's configuration is global, so theme-sensitive renders run in order. */
export function renderMermaid(source: string, palette: Readonly<Record<string, string>>): Promise<string> {
	const safeSource = selfContainedMermaid(source);
	const render = queue.catch(() => {}).then(async () => {
		const container = document.createElement("div");
		container.style.position = "absolute";
		container.style.visibility = "hidden";
		document.body.append(container);
		try {
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "sandbox",
				suppressErrorRendering: true,
				maxTextSize: 100_000,
				maxEdges: 500,
				theme: "base",
				fontFamily: "Geist, sans-serif",
				htmlLabels: false,
				flowchart: { htmlLabels: false },
				themeVariables: {
					primaryColor: palette.surface, primaryTextColor: palette.fg, primaryBorderColor: palette.border,
					lineColor: palette.muted, secondaryColor: palette.surface, tertiaryColor: palette.surface,
					textColor: palette.fg, mainBkg: palette.surface, nodeBorder: palette.border,
					clusterBkg: palette.surface, clusterBorder: palette.border, edgeLabelBackground: palette.surface,
					actorBkg: palette.surface, actorBorder: palette.border, actorTextColor: palette.fg,
					signalColor: palette.fg, signalTextColor: palette.fg, labelTextColor: palette.fg,
				},
			});
			// Mermaid performs its layout inside a temporary sandboxed iframe. Never insert its returned HTML.
			const result = (await mermaid.render(`vomp-mermaid-${sequence++}`, safeSource, container)).svg;
			const encoded = /src="data:text\/html;charset=UTF-8;base64,([A-Za-z0-9+/=]+)"/.exec(result)?.[1];
			if (!encoded) throw new Error("Mermaid did not return a sandboxed drawing");
			const html = new TextDecoder().decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)));
			const start = html.indexOf("<svg");
			const end = html.lastIndexOf("</svg>");
			if (start < 0 || end < start) throw new Error("Mermaid did not return SVG");
			return html.slice(start, end + 6);
		} finally {
			container.remove();
		}
	});
	queue = render;
	return render;
}
