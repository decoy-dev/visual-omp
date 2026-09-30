import { CircleCheck, CircleX, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton, Progress } from "@/ui";
import type { Operation } from "./operations";

/** Inline progress for one running operation: bar + the latest output line. */
export function InlineProgress({ op }: { op: Operation }) {
	const { t } = useTranslation("extensions");
	const label = t(`ops.${op.verb}`, { name: op.subject });
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<Progress aria-label={label} className="w-full" />
			<span className="truncate font-mono text-xs text-fg-faint" aria-live="polite">
				{op.lines.at(-1) ?? label}
			</span>
		</div>
	);
}

/** Streamed output of recent operations, newest first; running ones can be cancelled. */
export function OperationLog({ ops, onCancel, onDismiss }: { ops: Operation[]; onCancel(opId: string): void; onDismiss(opId: string): void }) {
	const { t } = useTranslation("extensions");
	if (ops.length === 0) return null;
	return (
		<section aria-label={t("ops.activity")} className="flex flex-col gap-2">
			<h3 className="text-sm font-semibold text-fg-muted">{t("ops.activity")}</h3>
			{ops.map(op => (
				<OperationCard key={op.opId} op={op} onCancel={() => onCancel(op.opId)} onDismiss={() => onDismiss(op.opId)} />
			))}
		</section>
	);
}

function OperationCard({ op, onCancel, onDismiss }: { op: Operation; onCancel(): void; onDismiss(): void }) {
	const { t } = useTranslation("extensions");
	const pre = useRef<HTMLPreElement>(null);
	useEffect(() => {
		const el = pre.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [op.lines.length]);
	const label = t(`ops.${op.verb}`, { name: op.subject });
	return (
		<div className="rounded-md border border-border bg-panel">
			<div className="flex items-center gap-2 px-3 py-2 text-sm">
				{op.running ? null : op.error ? (
					<CircleX aria-hidden className="size-4 shrink-0 text-err" />
				) : (
					<CircleCheck aria-hidden className="size-4 shrink-0 text-ok" />
				)}
				<span className="min-w-0 flex-1 truncate font-medium text-fg">
					{op.running ? label : op.error ? t("ops.failed", { name: op.subject }) : t("ops.done", { name: op.subject })}
				</span>
				{op.running ? (
					<Button size="sm" variant="ghost" onClick={onCancel}>
						{t("common.cancel")}
					</Button>
				) : (
					<IconButton size="sm" label={t("ops.dismiss")} icon={<X />} onClick={onDismiss} />
				)}
			</div>
			{op.running && <Progress aria-label={label} className="px-3 pb-2" />}
			{op.error && <p className="px-3 pb-2 text-sm text-err">{op.error}</p>}
			{op.lines.length > 0 && (
				<details open={op.running} className="border-t border-border">
					<summary className="cursor-pointer px-3 py-1.5 text-xs text-fg-muted">{t("ops.output", { count: op.lines.length })}</summary>
					<pre
						ref={pre}
						tabIndex={0}
						className="max-h-44 overflow-auto bg-inset px-3 py-2 font-mono text-xs whitespace-pre-wrap text-fg-muted focus-visible:outline-2 focus-visible:outline-ring"
					>
						{op.lines.join("\n")}
					</pre>
				</details>
			)}
		</div>
	);
}
