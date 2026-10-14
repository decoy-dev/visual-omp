import type { MarkedExtension, Tokens } from "@oh-my-pi/pi-utils/marked";
import { type MathSpan, mathBlockAt, mathSpanAt, mathStartIndex } from "@oh-my-pi/pi-utils/math-delimiters";
import type { renderToString } from "katex";
import { useSyncExternalStore } from "react";
import { escapeHtml } from "../collab/lib/format";
import { preloadWhenIdle } from "../registry/idle";

/**
 * KaTeX loads from its own chunk: on the first math a message renders, or in idle time after startup.
 * Until then math renders as its source inside a `math` element marked `data-math-pending` (the same
 * inline or block box the typeset output takes), and the Markdown views render again once it loads.
 */
let typeset: typeof renderToString | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Marks math rendered as source while KaTeX loads; a block holding it renders again afterwards. */
export const MATH_PENDING = "data-math-pending";

export function loadMath(): Promise<void> {
	loading ??= import("katex").then(
		katex => {
			typeset = katex.renderToString;
			for (const listener of listeners) listener();
		},
		() => {
			loading = null;
		},
	);
	return loading;
}

preloadWhenIdle(loadMath);

function subscribeMath(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** True once KaTeX has loaded; Markdown views depend on it to replace math shown as source. */
export function useMathReady(): boolean {
	return useSyncExternalStore(subscribeMath, () => typeset !== null);
}

/**
 * A backtick between the delimiters means the run is prose that merely looks
 * like math (`$x `code` y$`): KaTeX cannot express a code span, so typesetting
 * would swallow it and print an error instead.
 */
function typesettable(span: MathSpan): boolean {
	return !span.body.includes("`");
}

function renderMath(token: Tokens.Generic): string | false {
	if (token.type !== "math" || typeof token.text !== "string" || typeof token.display !== "boolean") return false;
	const source = escapeHtml(typeof token.raw === "string" ? token.raw : token.text);
	// A display equation gets a wrapper to scroll in (`.tr-math`), because
	// scrolling the `math` element itself traps a few pixels of vertical scroll:
	// its ink — fraction bars, radical overlines — overflows its own box.
	const wrap = (math: string) => (token.display ? `<span class="tr-math">${math}</span>` : math);
	if (!typeset) {
		void loadMath();
		return wrap(`<math ${MATH_PENDING} display="${token.display ? "block" : "inline"}"><mtext>${source}</mtext></math>`);
	}
	try {
		return wrap(
			typeset(token.text, {
				displayMode: token.display,
				// KaTeX's HTML output needs katex.min.css, which bundles to ~940 KB
				// gzipped here because Bun inlines its 60 @font-face sources.
				output: "mathml",
				throwOnError: false,
				// `trust: false` refuses \href, \htmlClass, \includegraphics.
				strict: false,
				trust: false,
			}),
		);
	} catch {
		// KaTeX threw outside its own error handling (e.g. macro expansion limit):
		// show the source rather than let one span blank the whole message.
		return source;
	}
}

/**
 * Renders LaTeX in transcript Markdown: `$…$` and `\(…\)` inline, `$$…$$` and
 * `\[…\]` in display mode, plus own-line `$$`/`\[` blocks. Delimiters and the
 * scan hint come from `@oh-my-pi/pi-utils/math-delimiters`, so this renderer and
 * the TUI agree on what counts as math; only presentation policy lives here.
 *
 * Two limits follow from that shared behavior, both matching the TUI: a rejected
 * opener hides later spans on its line ("it costs $5, and the growth is $x^2$"
 * typesets nothing, since marked drops a `start` hint of 0), and a display block
 * whose body contains a blank line must be preceded by one — attached blocks are
 * tokenized by the inline rule, which a blank line ends.
 */
export const mathExtension: MarkedExtension = {
	extensions: [
		{
			name: "math",
			level: "block",
			// No `start` hint: this parser probes block extensions only at a block
			// boundary and never consults their hints.
			tokenizer(source) {
				const block = mathBlockAt(source);
				if (!block) return undefined;
				return { type: "math", raw: block.raw, text: block.body, display: true };
			},
			renderer: renderMath,
		},
		{
			name: "math",
			level: "inline",
			start: mathStartIndex,
			tokenizer(source) {
				const span = mathSpanAt(source, 0);
				if (!span || !typesettable(span)) return undefined;
				return { type: "math", raw: source.slice(0, span.end), text: span.body, display: span.display };
			},
			renderer: renderMath,
		},
	],
};
