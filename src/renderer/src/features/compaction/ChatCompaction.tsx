import { compactAtValue, formatCompactAt } from "@shared/compaction";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatSlotProps } from "@/registry/slots";
import { useVisualSnapshot } from "@/state/visualSnapshot";
import { Button, Slider, toast } from "@/ui";
import { ipcErrorMessage } from "../manage/shared";
import { chatCompactionPreview, compactionTicks } from "../manage/roles/compactionModel";
import { useChatModels } from "../session-tools/model";
import { useCompactionSettings } from "./settingsCache";

/**
 * "Summarize this chat at" in the composer's context popover: a slider up to the chat's context window, with
 * ticks at equal parts of it. The point is saved for this chat's omp session and reaches omp through the chat's
 * config overlay; the status line says where omp summarizes with the current model.
 */
export function ChatCompaction({ session }: ChatSlotProps) {
	const { t } = useTranslation("composer");
	const view = useVisualSnapshot(session.subscribe, session.getSnapshot);
	const host = view.host;
	const contextWindow = view.guest?.state?.contextUsage?.contextWindow ?? null;
	const { settings, failed, retry } = useCompactionSettings(session.projectPath);
	const { models } = useChatModels(session.projectPath);
	const wire = view.guest?.state?.model;
	const model = wire ? models?.find(entry => entry.provider === wire.provider && entry.id === wire.id) : undefined;
	const saved = compactAtValue(host?.compactAt);
	// A draft belongs to the chat session it was made in.
	const destination = `${host?.hostId}\0${host?.generation}\0${host?.sessionId}`;
	const [draft, setDraft] = useState<number | null>(null);
	const [target, setTarget] = useState(destination);
	const [busy, setBusy] = useState(false);
	if (target !== destination) { setTarget(destination); setDraft(null); }
	if (!contextWindow) return null;
	const { min, max, step, ticks } = compactionTicks(contextWindow);
	const inherited = model && settings ? chatCompactionPreview(model, settings, null) : null;
	const preview = model && settings ? chatCompactionPreview(model, settings, draft ?? saved) : null;
	const point = draft ?? saved;
	const position = Math.min(max, Math.max(min, point ?? inherited?.tokens ?? max));
	const disabled = view.readOnly || !host?.sessionId || host.phase === "exited" || busy;
	const labelEvery = ticks.length > 5 ? 2 : 1;
	const marks = ticks.map((value, index) => ({ value, label: (index + 1) % labelEvery === 0 || index === ticks.length - 1 ? formatCompactAt(value) : undefined }));
	const save = async (tokens: number | null) => {
		if (!host?.sessionId || disabled) return;
		setBusy(true);
		try {
			await window.vomp.invoke("host:setCompactAt", host.hostId, host.generation, host.sessionId, tokens);
			setDraft(null);
		} catch (error) {
			toast({ tone: "err", message: t("context.compactAt.failed"), description: ipcErrorMessage(error) });
		} finally { setBusy(false); }
	};
	const status = !settings ? t(failed ? "context.compactAt.readFailed" : "context.compactAt.loading")
		: !model ? t("context.compactAt.loading")
		: !preview?.enabled ? t("context.compactAt.off")
		: preview.tokens === null ? t("context.compactAt.unknown")
		: t(`context.compactAt.${preview.source}`, { tokens: formatCompactAt(preview.tokens), model: preview.modelKey });
	return (
		<div className="mt-3 border-t border-border pt-3">
			<div className="flex items-baseline justify-between gap-2">
				<p className="text-sm font-medium text-fg">{t("context.compactAt.label")}</p>
				<span className="font-mono text-sm tabular-nums text-fg">
					{point !== null ? formatCompactAt(point) : (
						<span className="text-fg-muted">{inherited?.tokens != null ? t("context.compactAt.inherited", { tokens: formatCompactAt(inherited.tokens) }) : t("context.compactAt.placeholder")}</span>
					)}
				</span>
			</div>
			<Slider
				className="mt-2"
				aria-label={t("context.compactAt.label")}
				min={min}
				max={max}
				step={step}
				value={position}
				marks={marks}
				formatValue={formatCompactAt}
				disabled={disabled}
				onValueChange={setDraft}
			/>
			<p className="mt-1 text-xs text-fg-muted" role="status">
				{status}
				{settings && failed && <> {t("context.compactAt.stale")}</>}
			</p>
			{failed && <Button className="mt-1" size="sm" variant="ghost" onClick={retry}>{t("context.compactAt.retry")}</Button>}
			<div className="mt-2 flex items-center gap-2">
				{saved !== null && (
					<Button size="sm" variant="ghost" disabled={disabled} onClick={() => void save(null)}>{t("context.compactAt.reset")}</Button>
				)}
				<div className="ml-auto flex items-center gap-2">
					{draft !== null && (
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t("context.compactAt.discard")}</Button>
					)}
					<Button size="sm" variant="secondary" disabled={disabled || draft === null || draft === saved} loading={busy} onClick={() => void save(draft)}>
						{t("context.compactAt.save")}
					</Button>
				</div>
			</div>
			<p className="mt-2 text-xs text-fg-faint">{t("context.compactAt.scope")}</p>
		</div>
	);
}
