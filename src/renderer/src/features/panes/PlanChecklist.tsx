/** "Plan checklist": a plan file's checkbox steps, shown by the Plan pane and the Plan Review card. */
import { CheckSquare, Square } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn, Definition } from "../../ui";
import { planChecklist } from "./derive";

/**
 * The plan's checkbox steps as omp saved them, ticked or not. Plans without checkboxes render nothing; no overall
 * completion is inferred, since steps are omp's own wording and need not be equal work.
 */
export function PlanChecklist({ text, className }: { text: string; className?: string }) {
	const { t } = useTranslation("panes");
	const steps = useMemo(() => planChecklist(text), [text]);
	if (!steps) return null;
	return (
		<section aria-label={t("plan.checklist")} className={cn("rounded-lg border border-border bg-panel p-card", className)}>
			<h3 className="mb-2 text-sm font-semibold text-fg">
				<Definition content={t("plan.checklistHint")}>{t("plan.checklist")}</Definition>
			</h3>
			<ol className="flex flex-col">
				{steps.map((step, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: steps are read in file order
					<li key={index} className="flex min-h-7 items-start gap-2 py-1 text-md" style={{ paddingLeft: `${step.depth * 1.25}rem` }}>
						{step.checked ? (
							<CheckSquare weight="fill" className="mt-px size-4 shrink-0 text-accent" aria-hidden />
						) : (
							<Square className="mt-px size-4 shrink-0 text-fg-faint" aria-hidden />
						)}
						<span className="sr-only">{step.checked ? t("plan.checked") : t("plan.unchecked")}</span>
						<span className={cn("min-w-0 flex-1 leading-5", step.checked ? "text-fg-muted" : "text-fg")}>{step.text}</span>
					</li>
				))}
			</ol>
		</section>
	);
}
