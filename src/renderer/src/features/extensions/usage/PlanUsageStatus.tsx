import type { TFunction } from "i18next";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PaneProps } from "@/registry/slots";
import { useNow, useSessionView } from "@/shell/hooks";
import { openUsage } from "@/state/navigation";
import { cn, Tooltip } from "@/ui";
import { focusRing } from "@/ui/styles";
import { formatAge, formatDuration } from "../format";
import { refreshUsageLimits, useUsageLimits } from "./limitsStore";
import { chatModel, modelsInUse, planUsage, type ProviderUsage, providerName, type WindowUsage } from "./planUsage";

const fills: Record<WindowUsage["tone"], string> = { ok: "bg-ok", warn: "bg-warn", err: "bg-err" };
const inks: Record<WindowUsage["tone"], string> = { ok: "", warn: "text-warn", err: "text-err" };

/**
 * Fold steps, applied in order while the status bar overflows: window names first so every provider
 * stays visible longest, then the other providers ("+N"), then provider names, then percents.
 */
const FOLDS = ["data-fold-window", "data-fold-more", "data-fold-name", "data-fold-text"] as const;

/**
 * Folds the item step by step while any status bar column overflows, measuring synchronously so no
 * frame shows an overlapped bar. It settles from no folds again when the bar's content changes or the
 * text size changes; when the bar widens it unfolds a step only once it is wider than where that step
 * last failed, so the fold cannot oscillate. Folds are attributes read by CSS, so applying one never
 * re-renders React, and neither observer watches those attributes.
 *
 * The text-size preference is applied by App's passive effect (`html.style.fontSize`), which runs
 * after this component's effects, so the fit watches that style attribute, which changes only once
 * the new size is in place, instead of the preference value itself.
 */
function useStatusBarFit(root: HTMLElement | null): void {
	useLayoutEffect(() => {
		const footer = root?.closest("footer");
		if (!root || !footer) return;
		/** Footer width at which each fold step last failed to fit. */
		let failedAt: number[] = [];
		let current = 0;
		let width = footer.clientWidth;
		const settle = (from: number) => {
			let next = from;
			for (;;) {
				FOLDS.forEach((attr, index) => root.toggleAttribute(attr, index < next));
				if (next === FOLDS.length || [...footer.children].every(column => column.scrollWidth <= column.clientWidth)) break;
				failedAt[next] = width;
				next++;
			}
			current = next;
		};
		const restart = () => {
			failedAt = [];
			settle(0);
		};
		restart();
		const resize = new ResizeObserver(() => {
			const next = footer.clientWidth;
			if (next === width) return;
			const grew = next > width;
			width = next;
			let from = current;
			while (grew && from > 0 && width > (failedAt[from - 1] ?? 0)) from--;
			settle(from);
		});
		resize.observe(footer);
		const mutations = new MutationObserver(restart);
		mutations.observe(footer, { subtree: true, childList: true, characterData: true });
		const textSize = new MutationObserver(restart);
		textSize.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
		document.fonts.addEventListener("loadingdone", restart);
		return () => {
			resize.disconnect();
			mutations.disconnect();
			textSize.disconnect();
			document.fonts.removeEventListener("loadingdone", restart);
		};
	}, [root]);
}

function percentOf(window: WindowUsage): number {
	return Math.round((window.fraction ?? 0) * 100);
}

/** "resets in 2h 14m", "Limit reached. Resets in 2h 14m", or null when omp gives no future reset. */
function resetText(window: WindowUsage, now: number, t: TFunction<"extensions">): string | null {
	if (window.resetsAt === null || window.resetsAt <= now) return null;
	const atLimit = window.status === "exhausted" || (window.fraction ?? 0) >= 1;
	return t(atLimit ? "usage.atLimit" : "usage.resetsIn", { time: formatDuration(window.resetsAt - now) });
}

function PlanTooltip({ usage, now }: { usage: ProviderUsage[]; now: number }) {
	const { t, i18n } = useTranslation("extensions");
	const fetchedAt = Math.min(...usage.map(provider => provider.fetchedAt));
	return (
		<span className="flex flex-col gap-2 py-0.5 leading-normal">
			<span className="grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-0.5 font-normal">
				{usage.map((provider, index) => (
					<span key={provider.provider} className="contents">
						<span className={cn("col-span-3 font-semibold", index > 0 && "mt-1.5")}>
							{providerName(provider.provider)}
							{provider.accounts > 1 && <span className="font-normal text-fg-muted"> {t("usage.plan.pooled", { count: provider.accounts })}</span>}
						</span>
						{provider.windows.map(window => (
							<span key={window.id} className="contents">
								<span>
									<span className="font-mono">{window.window}</span>
									{window.detail && <span className="text-fg-muted"> {window.detail}</span>}
								</span>
								<span className={cn("font-mono tabular-nums", inks[window.tone])}>
									{window.fraction === null ? t("usage.plan.unknown") : t("usage.used", { percent: percentOf(window) })}
								</span>
								<span className="text-fg-muted">{resetText(window, now, t)}</span>
							</span>
						))}
					</span>
				))}
			</span>
			<span className="font-normal text-fg-muted">
				{t("usage.plan.checked", { age: formatAge(fetchedAt, now, i18n.language) })} {t("usage.plan.hint")}
			</span>
		</span>
	);
}

/**
 * Status bar (right): plan usage of the providers the focused chat and its
 * running subagents use, one meter per provider showing the window `pickTop` in planUsage.ts chooses
 * (an exhausted window, else 5h, else 7d, else monthly, else the most-used). Opens Usage & limits.
 */
export function PlanUsageStatus({ session, projectPath }: PaneProps) {
	const { t } = useTranslation("extensions");
	const view = useSessionView(session);
	const live = view?.guest?.state?.model;
	const saved = view?.history?.entries;
	const progress = view?.guest?.progress;
	const models = useMemo(
		() => modelsInUse(chatModel(live, saved ?? []), progress ? [...progress.values()].map(payload => payload.progress) : []),
		[live, saved, progress],
	);
	const providers = [...new Set(models.map(entry => entry.provider))].join(" ");
	const snapshot = useUsageLimits(providers !== "");
	useEffect(() => {
		if (providers) void refreshUsageLimits();
	}, [providers]);
	const usage = useMemo(() => planUsage(snapshot, models), [snapshot, models]);
	const now = useNow(30_000);
	const [root, setRoot] = useState<HTMLSpanElement | null>(null);
	useStatusBarFit(root);
	if (usage.length === 0) return null;
	return (
		<span ref={setRoot} className="group/plan flex h-full items-center">
			{usage.map(provider => {
				const { top } = provider;
				const reset = resetText(top, now, t);
				const name = providerName(provider.provider);
				const value = t("usage.plan.meterValue", { percent: percentOf(top), window: top.window });
				return (
					<span
						key={provider.provider}
						role="meter"
						className="sr-only"
						aria-label={provider.accounts > 1 ? t("usage.plan.meterLabelPooled", { provider: name, count: provider.accounts }) : t("usage.plan.meterLabel", { provider: name })}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.min(100, percentOf(top))}
						aria-valuetext={reset ? `${value}, ${reset}.` : `${value}.`}
					/>
				);
			})}
			<Tooltip content={<PlanTooltip usage={usage} now={now} />}>
				<button
					type="button"
					aria-label={t("usage.plan.open")}
					onClick={() => openUsage({ projectPath })}
					className={cn("inline-flex h-full items-center gap-3 rounded-sm px-1.5 text-fg-muted hover:bg-hover hover:text-fg", focusRing)}
				>
					{usage.map((provider, index) => (
						<span key={provider.provider} aria-hidden className={cn("inline-flex items-center gap-1.5", index > 0 && "group-data-[fold-more]/plan:hidden")}>
							<span className="relative h-1 w-5 shrink-0 overflow-hidden rounded-full bg-border-strong">
								<span
									className={cn(
										"absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-(--dur-spring-gentle) ease-(--ease-spring)",
										fills[provider.top.tone],
									)}
									style={{ width: `${Math.min(100, percentOf(provider.top))}%` }}
								/>
							</span>
							<span className={cn("inline-flex gap-1 whitespace-nowrap", inks[provider.top.tone])}>
								<span className="group-data-[fold-name]/plan:hidden">{providerName(provider.provider)}</span>
								<span className="group-data-[fold-window]/plan:hidden">{provider.top.window}</span>
								<span className="tabular-nums group-data-[fold-text]/plan:hidden">{t("usage.plan.percent", { percent: percentOf(provider.top) })}</span>
							</span>
						</span>
					))}
					{usage.length > 1 && (
						<span aria-hidden className="hidden group-data-[fold-more]/plan:inline">
							{t("usage.plan.more", { count: usage.length - 1 })}
						</span>
					)}
				</button>
			</Tooltip>
		</span>
	);
}
