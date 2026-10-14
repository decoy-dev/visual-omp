/**
 * A finished turn's run of tool steps as one row (Normal view): "Worked for 1m 42s · 9 tool calls".
 * It opens to the same tool rows the turn showed while it ran. Elapsed time appears only when every call has a
 * known start and result time (see `turns.ts`). File changes belong to the turn's TurnSummary, not here. A turn that finishes in view (`settling`) mounts open, as its rows
 * stood a moment ago, and then folds, so the rows visibly gather into the summary instead of vanishing.
 */
import { CaretRight, Stack } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { elapsed } from "../../shell/hooks";
import { cn, Expand } from "../../ui";
import type { ToolGroupPlan } from "./turns";

export function ToolGroup({ plan, settling = false, children }: { plan: ToolGroupPlan; settling?: boolean; children: ReactNode }): ReactNode {
	const { t } = useTranslation("panes");
	const [open, setOpen] = useState(settling);
	// Fold once, on mount; a later click owns the state.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only
	useEffect(() => {
		if (!settling) return;
		const frame = requestAnimationFrame(() => setOpen(false));
		return () => cancelAnimationFrame(frame);
	}, []);
	const parts = [
		plan.elapsedMs !== null ? t("work.group.worked", { elapsed: elapsed(plan.elapsedMs) }) : null,
		t("work.group.calls", { count: plan.calls }),
	].filter((part): part is string => part !== null);
	return (
		<div className="group/steps">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				className="-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			>
				<Stack className="size-4 shrink-0 text-fg-faint" aria-hidden />
				<span className="min-w-0 truncate text-md text-fg-muted transition-colors duration-(--dur) group-hover/steps:text-fg">{parts.join(" · ")}</span>
				{plan.failed > 0 && <span className="shrink-0 text-sm text-err">{t("work.group.failed", { count: plan.failed })}</span>}
				<CaretRight
					className={cn("size-3.5 shrink-0 text-fg-faint transition-[rotate] duration-(--dur) ease-(--ease-out)", open && "rotate-90")}
					aria-hidden
				/>
			</button>
			<Expand open={open} className="ml-2 border-l border-border pt-1 pb-1 pl-3">
				{children}
			</Expand>
		</div>
	);
}
