import type { TspCodeProps, TspCommonProps } from "@shared/tsp";
import { Fragment, useMemo } from "react";
import { languageFor, SYN_CLASS, tokenizeLines } from "../../panes/highlight";
import { CodeBlock } from "../../../tool-render/parts";

export function Code({ p }: { p?: TspCodeProps & TspCommonProps }) {
	const text = p?.text ?? "";
	const lines = useMemo(() => text.split("\n"), [text]);
	const tokens = useMemo(() => tokenizeLines(lines, p?.lang ?? (p?.path ? languageFor(p.path) : null)), [lines, p?.lang, p?.path]);
	if (!p?.numbers && !p?.nums && p?.start === undefined) return <CodeBlock code={text} lang={p?.lang} title={p?.path} />;
	const nums = p.nums?.length === lines.length && p.nums.every((n, i, all) => Number.isFinite(n) && (i === 0 || n > all[i - 1]!)) ? p.nums : null;
	const number = (index: number) => nums?.[index] ?? (p.start ?? 1) + index;
	return <div className="tv-out">
		{p.path && <div className="tv-out-title">{p.path}</div>}
		<pre className={`tv-pre tsp-code${p.wrap ? " tv-pre--wrap" : ""}`}><code>{lines.map((_, i) => <Fragment key={i}>
			{i > 0 && "\n"}{i > 0 && number(i) !== number(i - 1) + 1 && <><span className="tsp-code-gap">…</span>{"\n"}</>}
			<span data-tsp-line={number(i)}>{p.numbers !== false && <span className="tsp-code-number" aria-hidden>{number(i)}</span>}{tokens[i]!.map((token, j) => <span key={j} className={SYN_CLASS[token.role]}>{token.text}</span>)}</span>
		</Fragment>)}</code></pre>
	</div>;
}
