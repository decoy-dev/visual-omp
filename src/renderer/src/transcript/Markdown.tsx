import type { ReactNode } from "react";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { MarkdownBlocks, renderMarkdown } from "./render";

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return <div className="tr-md" dangerouslySetInnerHTML={{ __html: html }} />;
});

interface MountedBlock {
	key: string;
	nodes: ChildNode[];
}

/**
 * Markdown for a message that is still streaming. It renders the same HTML as {@link Markdown},
 * but each top-level block owns its own DOM nodes: an update replaces only the blocks whose
 * source changed (usually the last one), so finished blocks keep their layout and any text
 * selection in them. The nodes sit directly in `.tr-md`, so the transcript CSS and the
 * streaming caret apply exactly as they do to a saved message.
 */
export function StreamingMarkdown({ text }: { text: string }): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	const renderer = useRef<MarkdownBlocks | null>(null);
	const mounted = useRef<MountedBlock[]>([]);
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		renderer.current ??= new MarkdownBlocks();
		const blocks = renderer.current.render(text);
		const previous = mounted.current;
		let kept = 0;
		while (kept < previous.length && kept < blocks.length && previous[kept]?.key === blocks[kept]?.key) kept++;
		for (const block of previous.slice(kept)) for (const node of block.nodes) node.remove();
		const next = previous.slice(0, kept);
		const template = document.createElement("template");
		for (const block of blocks.slice(kept)) {
			template.innerHTML = block.html;
			next.push({ key: block.key, nodes: [...template.content.childNodes] });
			root.append(template.content);
		}
		mounted.current = next;
	}, [text]);
	return <div ref={ref} className="tr-md" />;
}
