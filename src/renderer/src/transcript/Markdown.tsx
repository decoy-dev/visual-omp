import type { ReactNode } from "react";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { i18n } from "../i18n";
import { toast } from "../ui/toast";
import { blockIn, useMotionReduced } from "../ui/motion";
import { hydrateRichContent, useRichContent } from "../ui/rich-content";
import { MATH_PENDING, useMathReady } from "./math";
import { MarkdownBlocks, renderMarkdown } from "./render";

/**
 * Copies the code block whose Copy button (rendered by `render.ts`) was clicked. True when the click was on such a
 * button, so a surrounding click handler stops there; the event is marked handled, so nested handlers copy once.
 */
export function copyCode(event: { target: EventTarget | null; defaultPrevented: boolean; preventDefault(): void }): boolean {
	const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-copy-code]") : null;
	const code = button?.closest(".tr-code")?.querySelector("pre code");
	if (!button || !code) return false;
	if (event.defaultPrevented) return true;
	event.preventDefault();
	void navigator.clipboard.writeText(code.textContent ?? "").then(() => {
		button.dataset.copied = "";
		setTimeout(() => delete button.dataset.copied, 1500);
		toast({ tone: "ok", message: i18n.t("chat:copied") });
	});
	return true;
}

/** A whole message's HTML; math shown as source while KaTeX was loading is typeset once it has loaded. */
export function useMarkdownHtml(text: string): string {
	const math = useMathReady();
	const parsed = useMemo(() => renderMarkdown(text), [text]);
	return useMemo(() => (math && parsed.includes(MATH_PENDING) ? renderMarkdown(text) : parsed), [math, parsed, text]);
}

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	const html = useMarkdownHtml(text);
	const ref = useRef<HTMLDivElement>(null);
	useRichContent(ref, html);
	return <div ref={ref} className="tr-md" onClick={copyCode} dangerouslySetInnerHTML={{ __html: html }} />;
});

/** A reveal that is this short at mount is just starting, so its first block enters like the ones after it. */
const FRESH_TEXT = 120;

interface MountedBlock {
	key: string;
	nodes: ChildNode[];
	/** `performance.now()` when this block's entrance began, while it still plays; null otherwise. */
	enteredAt: number | null;
}

/**
 * Markdown for a message that is still streaming. It renders the same HTML as {@link Markdown},
 * but each top-level block owns its own DOM nodes: an update replaces only the blocks whose
 * source changed (usually the last one), so finished blocks keep their layout and any text
 * selection in them. The nodes sit directly in `.tr-md`, so the transcript CSS and the
 * streaming caret apply exactly as they do to a saved message.
 *
 * With `blockIn`, a block appended past the previous end fades in (`blockIn` in ui/motion). A
 * block re-rendered while it grows continues its own entrance instead of starting another, and
 * finished blocks never animate again.
 */
export function StreamingMarkdown({ text, blockIn: enter = false }: { text: string; blockIn?: boolean }): ReactNode {
	const reduced = useMotionReduced();
	const math = useMathReady();
	const ref = useRef<HTMLDivElement | null>(null);
	const renderer = useRef<MarkdownBlocks | null>(null);
	const mounted = useRef<MountedBlock[] | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `math` re-renders blocks that showed math as source.
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		renderer.current ??= new MarkdownBlocks();
		const blocks = renderer.current.render(text);
		const first = mounted.current === null;
		const previous = mounted.current ?? [];
		let kept = 0;
		while (kept < previous.length && kept < blocks.length && previous[kept]?.key === blocks[kept]?.key) kept++;
		for (const block of previous.slice(kept)) for (const node of block.nodes) node.remove();
		const next = previous.slice(0, kept);
		const now = performance.now();
		const template = document.createElement("template");
		for (const [offset, block] of blocks.slice(kept).entries()) {
			const index = kept + offset;
			template.innerHTML = block.html;
			const nodes = [...template.content.childNodes];
			// New: past the previous end (or the opening of a reveal). Replaced: carries on the entrance it had.
			let enteredAt = index < previous.length ? (previous[index]?.enteredAt ?? null) : first && text.length > FRESH_TEXT ? null : now;
			if (!enter) enteredAt = null;
			if (enteredAt !== null) {
				let playing = false;
				for (const node of nodes) if (node instanceof Element && blockIn(node, reduced, now - enteredAt)) playing = true;
				if (!playing) enteredAt = null;
			}
			next.push({ key: block.key, nodes, enteredAt });
			root.append(template.content);
		}
		mounted.current = next;
		return hydrateRichContent(root, true);
	}, [text, enter, reduced, math]);
	// Only the chat transcript streams; its click handler runs `copyCode` for these blocks and for saved replies.
	return <div ref={ref} className="tr-md" />;
}
