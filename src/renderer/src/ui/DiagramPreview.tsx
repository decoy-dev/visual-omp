import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useRichContent } from "./rich-content";

/** Shared write preview for .svg and .mmd files, using the reply fence renderer. */
export function DiagramPreview({ source, language, label }: { source: string; language: "svg" | "mermaid"; label?: string }) {
	const { t } = useTranslation("chat");
	const ref = useRef<HTMLDivElement>(null);
	useRichContent(ref, `${language}\0${source}\0${label || ""}`);
	return <div ref={ref}><div className="vomp-diagram" data-diagram={language} data-label={label}>
		<div data-diagram-image />
		<details open><summary>{t("visual.source")}</summary><pre><code>{source}</code></pre></details>
	</div></div>;
}
