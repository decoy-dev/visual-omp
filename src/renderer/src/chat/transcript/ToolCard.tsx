import type { LucideIcon } from "lucide-react";
import {
	BookOpen,
	Bot,
	Brain,
	ChevronRight,
	CircleHelp,
	Code2,
	FilePen,
	FilePlus,
	FileSearch,
	Globe,
	ListChecks,
	Search,
	SquareTerminal,
	Wrench,
} from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { friendlySummary, resolveToolCall } from "../friendly";
import { resolveToolRenderer } from "../../tool-render/registry";
import type { ToolRenderHost, ToolResultLike } from "../../tool-render/types";
import { replaceTabs, stripAnsi } from "../../tool-render/util";
import "../../tool-render/tool-render.css";
import { cn, PulseDot } from "../../ui";

const ICONS: Record<string, LucideIcon> = {
	edit: FilePen,
	apply_patch: FilePen,
	ast_edit: FilePen,
	write: FilePlus,
	read: BookOpen,
	grep: Search,
	search: Search,
	ast_grep: Search,
	glob: FileSearch,
	find: FileSearch,
	bash: SquareTerminal,
	task: Bot,
	wait: Bot,
	todo: ListChecks,
	web_search: Globe,
	fetch: Globe,
	eval: Code2,
	python: Code2,
	js: Code2,
	notebook: Code2,
	ask: CircleHelp,
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
	host?: ToolRenderHost;
}

function partialText(partial: unknown): string {
	if (typeof partial === "string") return partial;
	if (partial && typeof partial === "object" && "content" in partial && Array.isArray(partial.content)) {
		return partial.content.map(block => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "")).join("");
	}
	return "";
}

/** One tool call as a friendly one-liner (DESIGN §4.7) that expands to omp's own detailed renderer. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const { t } = useTranslation("tools");
	const tc = useTranslation("chat").t;
	const [open, setOpen] = useState(props.verbose);
	const call = resolveToolCall({ name: props.name, args: props.args, result: props.result, running: props.running, intent: props.intent });
	const summary = friendlySummary(call);
	const renderer = resolveToolRenderer(call.name);
	const Icon = ICONS[call.name] ?? Wrench;
	const tail = summary.status === "running" ? stripAnsi(replaceTabs(partialText(props.partialResult))) : "";
	const rail = summary.status === "running" ? "" : summary.status === "error" ? "shadow-[inset_2px_0_0_var(--err)]" : "shadow-[inset_2px_0_0_var(--ok)]";

	return (
		<div
			className={cn(
				"overflow-hidden rounded-lg bg-panel",
				summary.status === "running" ? "signal-working" : "border border-border",
				rail,
			)}
		>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				title={call.intent}
				className="flex h-10 w-full items-center gap-2.5 px-3.5 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			>
				<ChevronRight className={cn("size-3.5 shrink-0 text-fg-faint transition-transform duration-(--dur-fast)", open && "rotate-90")} aria-hidden />
				<Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
				<span className="min-w-0 flex-1 truncate text-md font-medium text-fg">{t(summary.key, summary.values)}</span>
				{summary.added !== undefined && (
					<span className="shrink-0 font-mono text-sm">
						<span className="text-diff-add-text">+{summary.added}</span> <span className="text-diff-del-text">−{summary.removed}</span>
					</span>
				)}
				{summary.status === "running" ? (
					<PulseDot label={t("generic.running", { tool: call.name })} />
				) : summary.status === "error" ? (
					<span className="shrink-0 text-err" aria-label={tc("stopped.error")}>
						✕
					</span>
				) : (
					<span className="shrink-0 text-ok" aria-hidden>
						✓
					</span>
				)}
			</button>
			{tail && !open && (
				<pre className="selectable mx-3.5 mb-3 max-h-24 overflow-hidden rounded-md bg-inset px-3 py-2 font-mono text-code whitespace-pre-wrap text-fg-muted">
					{tail.length > 1200 ? `…${tail.slice(-1200)}` : tail}
				</pre>
			)}
			{open && (
				<div className="selectable border-t border-border px-3.5 py-3">
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
				</div>
			)}
		</div>
	);
});
