import { Binoculars, Brain, ChatCircleText, Check, ClipboardText, Code, FileMagnifyingGlass, Globe, Hourglass, Lightning, MagnifyingGlass, PaintBrush, PencilSimple, Robot, ShieldCheck, Sparkle, TerminalWindow, X } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "../../ui";
import type { Helper } from "./derive";

/** Agent names come from omp, including user and project definitions. Extend this table for new built-in types. */
const TYPE_ICONS: Readonly<Record<string, ReactNode>> = {
	task: <Code className="size-4" />,
	scout: <Binoculars className="size-4" />,
	reviewer: <FileMagnifyingGlass className="size-4" />,
	"security-reviewer": <ShieldCheck className="size-4" />,
	designer: <PaintBrush className="size-4" />,
	astra: <Sparkle className="size-4" />,
	seance: <Hourglass className="size-4" />,
	sonic: <Lightning className="size-4" />,
	"implementation-plan-drafter": <ClipboardText className="size-4" />,
};

export function HelperTypeIcon({ agentType }: { agentType?: string }): ReactNode {
	return agentType && Object.hasOwn(TYPE_ICONS, agentType) ? TYPE_ICONS[agentType] : <Robot className="size-4" />;
}

export type HelperActivity = "files" | "writing" | "commands" | "web" | "question" | "waiting" | "thinking";

/** Only the current tool counts. A completed read must not claim the helper is still reading. */
export function helperActivity(tool: string | undefined): HelperActivity {
	if (!tool) return "thinking";
	const name = tool.toLowerCase().replace(/^functions\./, "");
	if (name === "ask" || name === "ask_user" || name === "question") return "question";
	if (name === "wait" || name === "task" || name === "job") return "waiting";
	if (/web_search|browse|browser|fetch|search_docs/.test(name)) return "web";
	if (/^(edit|write|ast_edit|apply_patch)$/.test(name)) return "writing";
	if (/^(bash|eval|shell|exec|terminal)$/.test(name)) return "commands";
	if (/^(read|grep|glob|find|search|ls)$/.test(name)) return "files";
	return "thinking";
}

const ACTIVITY_ICONS: Record<HelperActivity, ReactNode> = {
	files: <MagnifyingGlass className="size-2.5" />,
	writing: <PencilSimple className="size-2.5" />,
	commands: <TerminalWindow className="size-2.5" />,
	web: <Globe className="size-2.5" />,
	question: <ChatCircleText className="size-2.5" />,
	waiting: <Hourglass className="size-2.5" />,
	thinking: <Brain className="size-2.5" />,
};

/** Decorative identity and activity; the surrounding row retains the helper's name and textual status. */
export function HelperIdentity({ helper, compact = false, className }: { helper: Pick<Helper, "agentType" | "currentTool" | "status">; compact?: boolean; className?: string }): ReactNode {
	const running = helper.status === "running";
	return <span aria-hidden="true" data-helper-type={helper.agentType ?? "unknown"} className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full", compact ? "size-6" : "size-8", running ? "bg-accent-muted text-accent" : "bg-inset text-fg-muted", className)}>
		<HelperTypeIcon agentType={helper.agentType} />
		<span data-helper-activity={running ? helperActivity(helper.currentTool) : undefined} className={cn("absolute -right-1 -bottom-0.5 inline-flex size-3.5 items-center justify-center rounded-full ring-2 ring-panel", running ? "bg-accent-muted text-accent" : helper.status === "done" ? "bg-ok-bg text-ok" : helper.status === "failed" ? "bg-err-bg text-err" : "bg-inset text-fg-muted")}>
			{running ? ACTIVITY_ICONS[helperActivity(helper.currentTool)] : helper.status === "done" ? <Check className="size-2.5" /> : <X className="size-2.5" />}
		</span>
	</span>;
}
