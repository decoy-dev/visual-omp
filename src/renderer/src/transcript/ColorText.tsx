import { useMemo } from "react";
import { colorTextHtml } from "./colors";

/** Plain text rendering with optional inline code for model-authored question text. */
export function ColorText({ text, inlineCode = false }: { text: string; inlineCode?: boolean }) {
	const html = useMemo(() => colorTextHtml(text, undefined, inlineCode), [text, inlineCode]);
	return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
