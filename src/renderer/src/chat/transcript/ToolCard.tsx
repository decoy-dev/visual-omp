import {
	BookOpen,
	Brain,
	CaretRight,
	Check,
	CodeSimple,
	FileMagnifyingGlass,
	FilePlus,
	Globe,
	type Icon,
	ListChecks,
	MagnifyingGlass,
	PencilSimpleLine,
	Question,
	Robot,
	TerminalWindow,
	Wrench,
	X,
} from "@phosphor-icons/react";
import { memo, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { friendlySummary, resolveToolCall } from "../friendly";
import { resolveToolRenderer } from "../../tool-render/registry";
import type { ToolRenderHost, ToolResultLike } from "../../tool-render/types";
import { replaceTabs, stripAnsi } from "../../tool-render/util";
import "../../tool-render/tool-render.css";
import { cn, Expand, PulseDot, Rise } from "../../ui";

const ICONS: Record<string, Icon> = {
	edit: PencilSimpleLine,
	apply_patch: PencilSimpleLine,
	ast_edit: PencilSimpleLine,
	write: FilePlus,
	read: BookOpen,
	grep: MagnifyingGlass,
	search: MagnifyingGlass,
	ast_grep: MagnifyingGlass,
	glob: FileMagnifyingGlass,
	find: FileMagnifyingGlass,
	bash: TerminalWindow,
	task: Robot,
	wait: Robot,
	todo: ListChecks,
	web_search: Globe,
	fetch: Globe,
	eval: CodeSimple,
	python: CodeSimple,
	js: CodeSimple,
	notebook: CodeSimple,
	ask: Question,
	retain: Brain,
	recall: Brain,
	reflect: Brain,
	learn: Brain,
};

export interface ToolCardProps {
	name: string;
	args: unknown;
	result?: ToolResultLike;
	running: boolean;
	intent?: string;
	partialResult?: unknown;
	/** Start expanded (Verbose view). */
	verbose: boolean;
	/** The call arrived while the reply streams in: the row rises into place. Saved rows render at rest. */
	arriving?: boolean;
	host?: ToolRenderHost;
}

function partialText(partial: unknown): string {
	if (typeof partial === "string") return partial;
	if (partial && typeof partial === "object" && "content" in partial && Array.isArray(partial.content)) {
		return partial.content.map(block => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "")).join("");
	}
	return "";
}

/**
 * One tool call as a quiet inline row (DESIGN §4.7): icon, friendly summary, a status glyph, and a disclosure
 * that expands to omp's own detailed renderer. Consecutive rows stack without gaps, so a run of calls reads as one list.
 */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const { t } = useTranslation("tools");
	const tc = useTranslation("chat").t;
	const [open, setOpen] = useState(props.verbose);
	const call = resolveToolCall({ name: props.name, args: props.args, result: props.result, running: props.running, intent: props.intent });
	const summary = friendlySummary(call);
	const renderer = resolveToolRenderer(call.name);
	const ToolIcon = ICONS[call.name] ?? Wrench;
	const running = summary.status === "running";
	const tail = running ? stripAnsi(replaceTabs(partialText(props.partialResult))) : "";

	return (
		<Rise play={props.arriving ?? false} distance={4} className="group/tool">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				title={call.intent}
				className="-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			>
				<ToolIcon className={cn("size-4 shrink-0 transition-colors duration-(--dur)", running ? "text-accent" : "text-fg-faint")} aria-hidden />
				<span className={cn("min-w-0 truncate text-md transition-colors duration-(--dur)", running ? "text-fg" : "text-fg-muted group-hover/tool:text-fg")}>
					{t(summary.key, summary.values)}
				</span>
				{summary.added !== undefined && (
					<span className="shrink-0 font-mono text-sm">
						<span className="text-diff-add-text">+{summary.added}</span> <span className="text-diff-del-text">−{summary.removed}</span>
					</span>
				)}
				<span className="inline-flex size-4 shrink-0 items-center justify-center">
					{running ? (
						<PulseDot label={t("generic.running", { tool: call.name })} />
					) : summary.status === "error" ? (
						<span className="inline-flex text-err" role="img" aria-label={tc("toolFailed")}>
							<X weight="bold" className="size-3.5" aria-hidden />
						</span>
					) : (
						<Check weight="bold" className="size-3.5 text-fg-faint" aria-hidden />
					)}
				</span>
				<CaretRight
					className={cn(
						"size-3.5 shrink-0 text-fg-faint opacity-0 transition-[rotate,opacity] duration-(--dur) ease-(--ease-out) group-hover/tool:opacity-100 group-focus-within/tool:opacity-100",
						open && "rotate-90 opacity-100",
					)}
					aria-hidden
				/>
			</button>
			<Expand open={tail.length > 0 && !open} className="pb-1.5 pl-6.5">
				<pre className="selectable max-h-24 overflow-hidden rounded-md bg-inset px-3 py-2 font-mono text-code whitespace-pre-wrap text-fg-muted">
					{tail.length > 1200 ? `…${tail.slice(-1200)}` : tail}
				</pre>
			</Expand>
			<Expand open={open} className="selectable pt-1 pb-3 pl-6.5">
				{call.intent && <p className="mb-2 text-sm text-fg-muted">{call.intent}</p>}
				<div className="tv-card tv-embedded">
					{renderer.Body ? (
						<renderer.Body name={call.name} args={call.args} result={call.result} running={call.running} host={props.host} />
					) : (
						<div className="tv-body">
							<renderer.Summary name={call.name} args={call.args} result={call.result} running={call.running} host={props.host} />
						</div>
					)}
				</div>
				{props.verbose && (
					<pre className="mt-2 max-h-60 overflow-auto rounded-md bg-inset px-3 py-2 font-mono text-code text-fg-muted">
						{JSON.stringify(call.args, null, 2)}
					</pre>
				)}
			</Expand>
		</Rise>
	);
});
