import { useMemo } from "react";
import { colorTextHtml } from "./colors";

/** Question text stays plain text, with the same decorative swatches as Markdown. */
export function ColorText({ text }: { text: string }) {
	const html = useMemo(() => colorTextHtml(text), [text]);
	return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
