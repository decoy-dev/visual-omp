import { createElement, type ReactNode } from "react";
import type { AskFormContextBlock, AskFormInlineRun } from "../../tool-render/tools/askForm";

function InlineRuns({ runs }: { runs: readonly AskFormInlineRun[] }): ReactNode {
	return <>{runs.map((run, index) => {
		if (run.type === "text") return <span key={index}>{run.text}</span>;
		const children = <InlineRuns runs={run.children} />;
		if (run.type === "strong") return <strong key={index} className="font-semibold text-fg">{children}</strong>;
		if (run.type === "em") return <em key={index}>{children}</em>;
		if (run.type !== "link") return <code key={index} className="rounded-sm bg-inset px-1 font-mono text-code text-fg">{children}</code>;
		const { href } = run;
		return <a key={index} href={href} onClick={event => {
			event.preventDefault();
			void window.vomp.invoke("app:openExternal", href);
		}} className="rounded-sm text-accent underline decoration-current/40 underline-offset-2 outline-none hover:text-accent-hover focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2">{children}</a>;
	})}</>;
}

function ContextBlock({ block }: { block: AskFormContextBlock }): ReactNode {
	if (block.type === "paragraph") return <p className="mb-2 last:mb-0 whitespace-normal"><InlineRuns runs={block.runs} /></p>;
	if (block.type === "heading") {
		const tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
		return createElement(tag, { className: "mb-1 text-md font-medium text-fg" }, <InlineRuns runs={block.runs} />);
	}
	const tag = block.ordered ? "ol" : "ul";
	const markerStyle = block.ordered ? "list-decimal" : "list-disc";
	return createElement(tag, { className: `mb-2 ms-1 ${markerStyle} list-outside space-y-0.5 ps-5 marker:text-fg-muted last:mb-0`, "data-context-list": block.ordered ? "ordered" : "unordered" }, block.items.map((runs, index) => createElement("li", { key: index, className: "min-w-0 whitespace-normal" }, <InlineRuns runs={runs} />)));
}

function textOfRuns(runs: readonly AskFormInlineRun[]): string {
	return runs.map(run => run.type === "text" ? run.text : textOfRuns(run.children)).join("");
}

function textOfBlock(block: AskFormContextBlock): string {
	return block.type === "list" ? block.items.map(textOfRuns).join(" ") : textOfRuns(block.runs);
}

/** Renders safe form prose above its question without repeating the question text. */
export function FormContext({ blocks, question }: { blocks: readonly AskFormContextBlock[]; question?: string }): ReactNode {
	const questionText = question?.trim();
	const visibleBlocks = questionText ? blocks.filter(block => textOfBlock(block).trim() !== questionText) : blocks;
	if (visibleBlocks.length === 0) return null;
	return <div data-form-context className="mb-3 min-w-0 break-words text-sm leading-5 text-fg-muted [overflow-wrap:anywhere]">
		{visibleBlocks.map((block, index) => <ContextBlock key={index} block={block} />)}
	</div>;
}
