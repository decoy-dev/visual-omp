import type { BashExecutionMessage, PythonExecutionMessage } from "@oh-my-pi/pi-wire";
import { CaretRight, Check, CodeSimple, Minus, TerminalWindow, X } from "@phosphor-icons/react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Output, ResultImages } from "../../tool-render/parts";
import { cn, Expand, PulseDot } from "../../ui";
import { TranscriptTime, type TranscriptTimestamp } from "./TranscriptTime";
import type { TranscriptMode } from "./Transcript";
import "../../tool-render/tool-render.css";

export type ExecutionMessage = BashExecutionMessage | PythonExecutionMessage;
export function isExecutionMessage(message: { role: string }): message is ExecutionMessage {
	return message.role === "bashExecution" || message.role === "pythonExecution";
}

export interface UserRun {
	kind: "shell" | "python";
	source: string;
	status: "running" | "done" | "error" | "cancelled";
	exitCode?: number;
	excluded?: boolean;
}

/** User-entered code keeps its attribution; output uses the same disclosure and well as tool steps. */
export function RunRow({ run, timestamp, mode, children }: { run: UserRun; timestamp?: TranscriptTimestamp; mode: TranscriptMode; children: ReactNode }): ReactNode {
	const { t } = useTranslation("chat");
	const [choice, setChoice] = useState<boolean | null>(null);
	const open = choice ?? mode === "verbose";
	const outputId = useId();
	const Icon = run.kind === "shell" ? TerminalWindow : CodeSimple;
	const status = run.status === "running" ? t("run.running") : run.status === "cancelled" ? t("run.cancelled") : run.exitCode !== undefined ? t("run.exit", { code: run.exitCode }) : t(run.status === "error" ? "toolFailed" : "run.finished");
	return <section className="group/run flex min-w-0 flex-col items-end gap-1" aria-label={t(`run.${run.kind}Label`)}>
		<div className="flex max-w-full flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-fg-faint [overflow-wrap:anywhere]">
			<TranscriptTime timestamp={timestamp} />
			<span className="font-medium text-fg-muted">{t("you")}</span>
			<span>{t(`run.${run.kind}`)}</span>
			{run.excluded && <span>{t("run.excluded")}</span>}
		</div>
		<pre className="selectable max-h-60 max-w-[85%] min-w-0 overflow-auto rounded-lg border border-border bg-inset px-4 py-3 font-mono text-code whitespace-pre-wrap text-fg [overflow-wrap:anywhere]" aria-label={t(`run.${run.kind}Source`)}><code>{run.source}</code></pre>
		<div className="w-full min-w-0">
			<button type="button" aria-expanded={open} aria-controls={outputId} onClick={() => setChoice(!open)} className="-mx-2 flex min-h-8 w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
				<Icon className="size-4 shrink-0 text-fg-faint" aria-hidden />
				<span className="text-md text-fg-muted">{t("run.output")}</span>
				<span className={cn("ml-auto text-xs", run.status === "error" ? "text-err" : "text-fg-faint")}>{status}</span>
				<span className="inline-flex size-4 shrink-0 items-center justify-center">
					{run.status === "running" ? <PulseDot label={t("run.running")} /> : run.status === "error" ? <X weight="bold" className="size-3.5 text-err" aria-hidden /> : run.status === "cancelled" ? <Minus weight="bold" className="size-3.5 text-fg-faint" aria-hidden /> : <Check weight="bold" className="size-3.5 text-fg-faint" aria-hidden />}
				</span>
				<CaretRight className={cn("size-3.5 shrink-0 text-fg-faint transition-[rotate] duration-(--dur) ease-(--ease-out)", open && "rotate-90")} aria-hidden />
			</button>
			<Expand open={open} className="selectable pt-1 pb-3 pl-6.5"><div id={outputId} className="tv-card tv-embedded">{children}</div></Expand>
		</div>
	</section>;
}

export function SavedRunRow({ message, timestamp, mode }: { message: ExecutionMessage; timestamp: TranscriptTimestamp; mode: TranscriptMode }): ReactNode {
	const { t } = useTranslation("chat");
	const run: UserRun = { kind: message.role === "bashExecution" ? "shell" : "python", source: message.role === "bashExecution" ? message.command : message.code, status: message.cancelled ? "cancelled" : message.exitCode !== undefined && message.exitCode !== 0 ? "error" : "done", exitCode: message.exitCode, excluded: message.excludeFromContext };
	return <RunRow run={run} timestamp={timestamp} mode={mode}>
		<div className="tv-body">
			{message.output ? <Output text={message.output} variant="code" maxLines={20} /> : <p className="text-sm text-fg-muted">{t("run.empty")}</p>}
			{message.truncated && <p className="mt-2 text-sm text-fg-muted">{t("run.truncated")}</p>}
			{message.role === "bashExecution" && message.images?.length ? <ResultImages result={{ content: message.images }} /> : null}
		</div>
	</RunRow>;
}
