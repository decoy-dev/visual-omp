import { useLayoutEffect, type RefObject } from "react";
import { i18n } from "../i18n";
import { figurePalette, sanitizeSvg, svgAccessibility, svgImage } from "./diagram-source";
import { closePartialSvg } from "./charts/vendor/omp/svg-source";
import { handleRemoteImage } from "./remote-images";
import { MermaidResourceError } from "./mermaid-policy";
import "./rich-content.css";

/** Hydrate only generated diagram/chart slots. Original Markdown remains available on failure. */
export function hydrateRichContent(root: HTMLElement, streaming = false): () => void {
	let live = true;
	const loadImage = (event: MouseEvent) => handleRemoteImage(event, root);
	root.addEventListener("click", loadImage);
	const update = () => {
		const palette = figurePalette(root);
		for (const slot of root.querySelectorAll<HTMLElement>("[data-diagram]")) {
			const source = slot.querySelector("pre code")?.textContent || "";
			const imageSlot = slot.querySelector<HTMLElement>("[data-diagram-image]");
			if (!imageSlot) continue;
			const language = slot.dataset.diagram;
			const partial = streaming && slot.hasAttribute("data-fence-open");
			if (partial && language === "mermaid") continue;
			const revision = `${source}\0${JSON.stringify(palette)}`;
			if (slot.dataset.revision === revision) continue;
			slot.dataset.revision = revision;
			slot.dataset.pending = "";
			const draw = async () => {
				try {
					// Keep Mermaid and its layout engines outside the initial renderer chunk.
					const svg = language === "mermaid" ? await (await import("./mermaid-render")).renderMermaid(source, palette) : partial ? closePartialSvg(source) : source;
					if (svg === null) { delete slot.dataset.pending; return; }
					if (!live || !root.contains(slot) || slot.dataset.revision !== revision) return;
					const clean = sanitizeSvg(svg, palette);
					if (!clean) throw new Error("Invalid SVG");
					const image = document.createElement("img");
					const accessibility = svgAccessibility(clean);
					image.alt = accessibility.name || slot.dataset.label || i18n.t(language === "mermaid" ? "chat:visual.mermaid" : "chat:visual.svg");
					if (accessibility.description) image.setAttribute("aria-description", accessibility.description);
					imageSlot.tabIndex = 0;
					imageSlot.setAttribute("role", "region");
					imageSlot.setAttribute("aria-label", image.alt);
					image.src = svgImage(clean);
					image.onerror = () => {
						if (live && root.contains(slot)) fail();
					};
					imageSlot.replaceChildren(image);
					slot.dataset.drawn = "";
					delete slot.dataset.pending;
					const details = slot.querySelector("details");
					if (details) details.open = false;
				} catch (error) {
					if (live && root.contains(slot) && slot.dataset.revision === revision) fail(error instanceof MermaidResourceError ? i18n.t("chat:visual.resourceDiagram") : undefined);
				}
			};
			const fail = (message = i18n.t("chat:visual.failed")) => {
				delete slot.dataset.drawn;
				delete slot.dataset.pending;
				imageSlot.textContent = message;
				const details = slot.querySelector("details");
				if (details) details.open = true;
			};
			void draw();
		}
		for (const slot of root.querySelectorAll<HTMLElement>("[data-table-chart]")) {
			// Match omp: a table at the end of a streaming reply may receive more rows.
			if (slot.dataset.drawn !== undefined || (streaming && slot === root.lastElementChild)) continue;
			slot.dataset.drawn = "";
			slot.dataset.pending = "";
			// Exact omp chart planning and drawing load only when a table is displayed.
			void import("./charts/table-chart").then(({ tableChart }) => {
				if (!live || !root.contains(slot)) return;
				const data = JSON.parse(slot.dataset.tableChart || "null") as { header: string[]; rows: string[][] };
				const svg = tableChart(data.header, data.rows);
				if (svg) slot.innerHTML = svg;
				delete slot.dataset.pending;
			}).catch(() => { if (live) delete slot.dataset.drawn; });
		}
	};
	update();
	const observer = new MutationObserver(update);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
	return () => {
		live = false;
		observer.disconnect();
		root.removeEventListener("click", loadImage);
		for (const slot of root.querySelectorAll<HTMLElement>("[data-pending]")) {
			delete slot.dataset.pending;
			delete slot.dataset.revision;
			delete slot.dataset.drawn;
		}
	};
}

export function useRichContent(ref: RefObject<HTMLElement | null>, html: string): void {
	useLayoutEffect(() => ref.current ? hydrateRichContent(ref.current) : undefined, [ref, html]);
}
