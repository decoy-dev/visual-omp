import type { ModelInfo } from "@shared/contracts/config";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLeaveGuard, whenLeaving } from "@/state/leaveGuard";
import { Button, Dialog, DialogContent, Input, Notice, SectionHeader } from "@/ui";
import type { OmpSettings } from "../settings/useOmpSettings";
import { ModelSelect } from "./ModelSelect";
import { matchingCompactionEntry, planCompaction, thresholdMap, type CompactionPolicy } from "./compactionModel";

const format = (tokens: number) => tokens.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });

export function CompactionLimits({ models, omp, onSaved }: { models: ModelInfo[] | null; omp: OmpSettings; onSaved(): void }) {
	const { t } = useTranslation("manage");
	const [selector, setSelector] = useState<string | null>(null);
	const model = models?.find(entry => entry.selector === selector);
	return (
		<section className="mt-8" aria-labelledby="model-compaction-title">
			<SectionHeader id="model-compaction-title" title={t("compaction.title")} description={t("compaction.description")} />
			<ModelSelect models={models ?? []} accepts={["chat", "tiny"]} value={selector} onChange={next => void whenLeaving(() => setSelector(next))} autoLabel={t("compaction.choose")} aria-label={t("compaction.model")} className="w-full" disabled={!models} />
			{model && <CompactionEditor key={`${model.selector}:${omp.scope}`} model={model} omp={omp} onSaved={onSaved} />}
		</section>
	);
}

function CompactionEditor({ model, omp, onSaved }: { model: ModelInfo; omp: OmpSettings; onSaved(): void }) {
	const { t } = useTranslation("manage");
	const setting = omp.byKey.get("compaction.modelThresholds");
	const own = thresholdMap(omp.scope === "global" ? setting?.globalValue : setting?.projectValue);
	const configured = Object.hasOwn(own, model.selector) ? own[model.selector] : null;
	const stored = typeof configured === "string" || typeof configured === "number" ? String(configured) : "";
	const [input, setInput] = useState(stored);
	const [saved, setSaved] = useState(stored);
	const [busy, setBusy] = useState(false);
	const [confirm, setConfirm] = useState(false);
	// A reload or scope change refreshes an untouched draft without overwriting edits.
	if (saved !== stored && input === saved) { setInput(stored); setSaved(stored); }
	const dirty = input.trim() !== saved;
	useLeaveGuard(dirty, () => setInput(saved));
	const number = (key: string, fallback: number) => typeof omp.byKey.get(key)?.value === "number" ? omp.byKey.get(key)!.value as number : fallback;
	const policy: CompactionPolicy = {
		enabled: omp.byKey.get("compaction.enabled")?.value !== false && omp.byKey.get("compaction.strategy")?.value !== "off",
		extendedContext: omp.byKey.get("extendedContext")?.value === true,
		modelThresholdsEnabled: omp.byKey.get("compaction.modelThresholdsEnabled")?.value !== false,
		thresholdPercent: number("compaction.thresholdPercent", -1),
		thresholdTokens: number("compaction.thresholdTokens", -1),
		reserveTokens: typeof omp.byKey.get("compaction.reserveTokens")?.value === "number" ? number("compaction.reserveTokens", 16_384) : undefined,
	};
	const inheritedEntries = { ...thresholdMap(setting?.value) };
	delete inheritedEntries[model.selector];
	if (omp.scope === "project") {
		const globalEntry = thresholdMap(setting?.globalValue)[model.selector];
		if (globalEntry !== undefined) inheritedEntries[model.selector] = globalEntry;
	}
	const inherited = matchingCompactionEntry(inheritedEntries, model.selector);
	const plan = planCompaction(model, input, policy, inherited?.entry ?? null);
	const shadowed = omp.scope === "global" && Object.hasOwn(thresholdMap(setting?.projectValue), model.selector);
	const save = async (confirmed = false) => {
		if (plan.error || shadowed) return;
		if (plan.opensExtended && !confirmed) { setConfirm(true); return; }
		setConfirm(false);
		setBusy(true);
		try {
			const next = { ...own };
			if (plan.entry === null) delete next[model.selector];
			else next[model.selector] = plan.entry;
			if (await omp.write("compaction.modelThresholds", next)) {
				setSaved(input.trim());
				void omp.snapshot.reload();
				onSaved();
			}
		} finally { setBusy(false); }
	};
	const values = { window: format(model.contextWindowTiers?.extended ?? model.contextWindow ?? 0) };
	return (
		<div className="mt-3 space-y-3">
			<form onSubmit={event => { event.preventDefault(); void save(); }} className="flex flex-wrap items-end gap-2">
				<Input className="min-w-0 flex-1" label={t("compaction.limit")} placeholder={t("compaction.placeholder")} spellCheck={false} value={input} disabled={shadowed} onChange={event => setInput(event.currentTarget.value)} error={plan.error ? t(`compaction.errors.${plan.error}`, values) : undefined} />
				<Button type="submit" disabled={!setting || !dirty || Boolean(plan.error) || shadowed} loading={busy}>{t("compaction.save")}</Button>
				<Button variant="ghost" disabled={!dirty || busy} onClick={() => setInput(saved)}>{t("roles.revert")}</Button>
			</form>
			<p className="text-sm text-fg-muted">{t("compaction.forms")}</p>
			<p className="text-sm text-fg-muted" role="status">
				{plan.error ? null : !policy.enabled ? t("compaction.off") : plan.tokens === null ? t("compaction.unknownWindow") : t(plan.appliesWhenEnabled ? "compaction.previewWhenEnabled" : "compaction.preview", { tokens: format(plan.tokens) })}
				{plan.tokens !== null && !plan.error && <span> {t(`compaction.basis.${plan.basis}`, { percent: Number(plan.percent?.toFixed(1)), base: format(plan.base ?? 0) })}</span>}
			</p>
			{input.trim() === "" && inherited && <p className="text-sm text-fg-muted">{t("compaction.inherited", { selector: inherited.key })}</p>}
			{shadowed && <Notice tone="warn">{t("compaction.shadowed")}</Notice>}
			{omp.byKey.get("compaction.modelThresholdsEnabled")?.value === false && <Notice tone="warn">{t("compaction.disabled")}</Notice>}
			<Dialog open={confirm} onOpenChange={setConfirm}>
				<DialogContent size="sm" title={t(plan.appliesWhenEnabled ? "compaction.extendedTitleWhenEnabled" : "compaction.extendedTitle")} description={t(plan.appliesWhenEnabled ? "compaction.extendedHelpWhenEnabled" : "compaction.extendedHelp", { window: format(plan.window ?? 0) })} footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>{t("common.cancel")}</Button><Button variant="primary" onClick={() => void save(true)}>{t(plan.appliesWhenEnabled ? "compaction.confirmWhenEnabled" : "compaction.confirm")}</Button></>}>
					{plan.premiumFrom !== null && <Notice tone="warn">{t(plan.appliesWhenEnabled ? "compaction.premiumWhenEnabled" : "compaction.premium", { tokens: format(plan.premiumFrom) })}</Notice>}
				</DialogContent>
			</Dialog>
		</div>
	);
}
