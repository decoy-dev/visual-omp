/**
 * The composer's own bottom-row tools, contributed through `chatSlots` like any feature's: voice (order
 * 50, VoiceTool.tsx) and the context ring (90, right of the model and thinking buttons). The ring drops
 * its percentage label in the row's compact states (Composer.tsx `useRowState`, DESIGN §3.6).
 */
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { type ChatSlotProps, chatSlots } from "../../registry/slots";
import { Button, cn, ContextRing, contextZone, Popover, PopoverContent, PopoverTrigger, Progress, Tooltip } from "../../ui";
import type { ComposerMode } from "./drafts";
import { VoiceTool } from "./VoiceTool";

/** The quick modes and the glyph that enters each one at the start of an empty box; the ＋ menu lists them. */
export const QUICK_MODES: ReadonlyArray<{ mode: ComposerMode; glyph: string }> = [
	{ mode: "shell", glyph: "!" },
	{ mode: "python", glyph: "$" },
];

const formatTokens = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function ContextTool({ session }: ChatSlotProps) {
	const { t } = useTranslation("composer");
	const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
	const usage = view.guest?.state?.contextUsage;
	if (!usage || usage.percent === null) return null;
	const percent = Math.round(usage.percent);
	const zone = contextZone(usage.percent);
	return (
		<Popover>
			<Tooltip content={t("context.tip", { percent })}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={t("context.label", { percent })}
						className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md px-1 outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						<ContextRing value={usage.percent} showLabel={zone !== "normal"} className="group-data-compact/composer:[&>span]:hidden" />
					</button>
				</PopoverTrigger>
			</Tooltip>
			<PopoverContent width={280} side="top" align="end">
				<p className="text-md font-semibold text-fg">{t("context.title")}</p>
				<p className="mt-1 text-sm text-fg-muted">{t("context.body")}</p>
				<div className="mt-3 flex items-baseline justify-between text-sm">
					<span className="font-mono tabular-nums text-fg">
						{usage.tokens !== null ? formatTokens.format(usage.tokens) : t("context.unknown")}
						<span className="text-fg-faint"> / {usage.contextWindow !== null ? formatTokens.format(usage.contextWindow) : t("context.unknown")}</span>
					</span>
					<span className={cn("font-mono tabular-nums", zone === "err" ? "text-err" : zone === "warn" ? "text-warn" : "text-fg-muted")}>
						{percent}%
					</span>
				</div>
				<Progress
					value={Math.min(100, usage.percent)}
					aria-label={t("context.title")}
					tone={zone === "normal" ? "accent" : zone}
					className="mt-2"
				/>
				<Button
					size="sm"
					variant={zone === "normal" ? "secondary" : "primary"}
					className="mt-3 w-full"
					disabled={view.working || view.readOnly}
					title={t("context.compactTip")}
					onClick={() => void session.command("/compact")}
				>
					{t("context.compact")}
				</Button>
				{view.working && <p className="mt-2 text-xs text-fg-faint">{t("context.compactBusy")}</p>}
			</PopoverContent>
		</Popover>
	);
}

chatSlots.register({ id: "composer.voice", placement: "composerTools", order: 50, component: VoiceTool });
chatSlots.register({ id: "composer.context", placement: "composerTools", order: 90, component: ContextTool });
