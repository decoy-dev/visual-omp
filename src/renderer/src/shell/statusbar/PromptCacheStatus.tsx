import { Database } from "@phosphor-icons/react";
import type { PromptCacheFact } from "@shared/tsp/prompt-cache";
import { Tooltip } from "../../ui/Tooltip";

/** Diagnostic text is quoted omp output, including its confidence and resend bounds. */
export function PromptCacheStatus({ fact }: { fact: PromptCacheFact | null }) {
	if (!fact) return null;
	return <Tooltip content={<span className="whitespace-pre-line leading-normal">{fact.detail}</span>}>
		<span tabIndex={0} aria-label={fact.detail} className={`flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1.5 ${fact.warning ? "text-warn" : ""}`}>
			<Database aria-hidden className="size-3.5 shrink-0" /><span className="max-w-[24ch] truncate">{fact.label}</span>
		</span>
	</Tooltip>;
}
