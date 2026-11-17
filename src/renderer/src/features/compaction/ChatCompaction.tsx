import { compactAtValue, formatCompactAt } from "@shared/compaction";
import { useTranslation } from "react-i18next";
import type { ChatSlotProps } from "@/registry/slots";
import { useVisualSnapshot } from "@/state/visualSnapshot";
import { toast } from "@/ui";
import { ipcErrorMessage } from "../manage/shared";
import { chatCompactionPreview } from "../manage/roles/compactionModel";
import { useOmpSettings } from "../manage/settings/useOmpSettings";
import { useChatModels } from "../session-tools/model";
import { CompactAtField } from "./CompactAtField";

/**
 * "Summarize this chat at" in the composer's context popover. The point is saved for this chat's omp session and
 * reaches omp through the chat's config overlay; the status line says where omp summarizes with the current model.
 */
export function ChatCompaction({ session }: ChatSlotProps) {
	const { t } = useTranslation("composer");
	const view = useVisualSnapshot(session.subscribe, session.getSnapshot);
	const host = view.host;
	const omp = useOmpSettings(session.projectPath, "project");
	const { models } = useChatModels(session.projectPath);
	const wire = view.guest?.state?.model;
	const model = wire ? models?.find(entry => entry.provider === wire.provider && entry.id === wire.id) : undefined;
	const chatTokens = compactAtValue(host?.compactAt);
	const ready = Boolean(model && omp.snapshot.data);
	const preview = ready ? chatCompactionPreview(model!, omp.byKey, chatTokens) : null;
	const inherited = ready ? chatCompactionPreview(model!, omp.byKey, null) : null;
	const save = async (tokens: number | null): Promise<boolean> => {
		if (!host?.sessionId) return false;
		try {
			await window.vomp.invoke("host:setCompactAt", host.hostId, host.generation, host.sessionId, tokens);
			return true;
		} catch (error) {
			toast({ tone: "err", message: t("context.compactAt.failed"), description: ipcErrorMessage(error) });
			return false;
		}
	};
	const status = !preview ? null
		: !preview.enabled ? t("context.compactAt.off")
		: preview.tokens === null ? t("context.compactAt.unknown")
		: t(`context.compactAt.${preview.source}`, { tokens: formatCompactAt(preview.tokens), model: preview.modelKey });
	return (
		<div className="mt-3 border-t border-border pt-3">
			<CompactAtField
				size="sm"
				label={t("context.compactAt.label")}
				destination={`${host?.hostId}\0${host?.generation}\0${host?.sessionId}`}
				value={chatTokens}
				placeholder={inherited?.enabled && inherited.tokens !== null ? t("context.compactAt.inherited", { tokens: formatCompactAt(inherited.tokens) }) : t("context.compactAt.placeholder")}
				disabled={view.readOnly || !host?.sessionId || host.phase === "exited"}
				onSave={save}
			/>
			{status && <p className="mt-2 text-xs text-fg-muted" role="status">{status}</p>}
			<p className="mt-1 text-xs text-fg-faint">{t("context.compactAt.scope")}</p>
		</div>
	);
}
