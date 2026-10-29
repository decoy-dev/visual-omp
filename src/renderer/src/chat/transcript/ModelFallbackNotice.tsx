import { Warning } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type { ModelFallback } from "../../collab/lib/modelFallback";

/** omp's reason is quoted as text, so provider errors and reported reset times keep their meaning. */
export function ModelFallbackNotice({ fallback }: { fallback: ModelFallback }) {
	const { t } = useTranslation("chat");
	return (
		<div role="note" className="flex items-start gap-2 rounded-md bg-warn-bg px-3 py-2 text-md text-warn">
			<Warning weight="fill" className="mt-0.5 size-4 shrink-0" aria-hidden />
			<div className="min-w-0 break-words [overflow-wrap:anywhere]">
				<p className="font-medium">{t(`modelFallback.${fallback.source === "provider" ? "provider" : fallback.from ? "changed" : "unknown"}`, { from: fallback.from, to: fallback.to })}</p>
				{fallback.reason && <p className="selectable mt-1 whitespace-pre-wrap text-sm">{t("modelFallback.reason", { reason: fallback.reason })}</p>}
			</div>
		</div>
	);
}
