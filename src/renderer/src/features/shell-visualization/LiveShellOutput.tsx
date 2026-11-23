import type { ReactNode } from "react";
import { useDeferredTranslation } from "../../i18n";
import { Output as TextOutput } from "../../tool-render/parts";
import { Button } from "../../ui/Button";
import { useLiveShell } from "./live";
import "./step-output.css";

/**
 * The bash card's output slot for a live command. A step chosen in omp's step mode shows its output in place of the
 * run's output, as omp's own bash card does; without a chosen step, or once the live view is gone, the card keeps
 * `output`.
 */
export function LiveShellOutput({ toolCallId, output }: { toolCallId: string; output: ReactNode }) {
	const { t } = useDeferredTranslation("shellVisualization");
	const { projection, unpin } = useLiveShell(toolCallId);
	const step = projection?.step;
	if (!step) return output;
	return <section className="shell-step-output" aria-label={t("stepOutput")}>
		<div className="shell-step-header">
			<span className="shell-step-label">{step.label}</span>
			{step.note && <span className="shell-step-meta">{step.note}</span>}
			{step.unpinId && <Button size="sm" variant="ghost" onClick={unpin}>{t("showAllOutput")}</Button>}
		</div>
		{step.output !== undefined ? (step.output ? <TextOutput text={step.output} maxLines={20} bare /> : <p className="shell-step-meta">{step.empty ?? t("noOutput")}</p>) : step.empty ? <p className="shell-step-meta">{step.empty}</p> : null}
	</section>;
}
