/**
 * The composer's own bottom-row tools, contributed through `chatSlots` like any feature's:
 * Shell `!` / Python `$` quick modes (order 30), voice (50, VoiceTool.tsx) and the context ring (60).
 */
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { type ChatSlotProps, chatSlots } from "../../registry/slots";
import { Button, cn, ContextRing, contextZone, Popover, PopoverContent, PopoverTrigger, Progress, Tooltip } from "../../ui";
import { type ComposerMode, useComposerDrafts } from "./drafts";
import { VoiceTool } from "./VoiceTool";

const MODES: Array<{ mode: ComposerMode; glyph: string }> = [
	{ mode: "shell", glyph: "!" },
	{ mode: "python", glyph: "$" },
];

function ModeToggles({ session }: ChatSlotProps) {
	const { t } = useTranslation("composer");
	const active = useComposerDrafts(state => state.modes[session.tabId] ?? null);
	const readOnly = useSyncExternalStore(session.subscribe, () => session.getSnapshot().readOnly);
	return (
		<div className="flex items-center gap-0.5">
			{MODES.map(({ mode, glyph }) => {
				const pressed = active === mode;
				return (
					<Tooltip key={mode} content={t(`modes.${mode}.tip`)}>
						<button
							type="button"
							aria-pressed={pressed}
							aria-label={t(`modes.${mode}.label`)}
							disabled={readOnly}
							onClick={() => {
								const store = useComposerDrafts.getState();
								store.setMode(session.tabId, pressed ? null : mode);
								store.focus(session.tabId);
							}}
							className={cn(
								"inline-flex h-7 items-center gap-1 rounded-md px-2 font-mono text-sm font-semibold outline-none transition-colors duration-(--dur-fast)",
								"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45",
								pressed ? "bg-accent-2-muted text-accent-2" : "text-fg-muted enabled:hover:bg-hover enabled:hover:text-fg",
							)}
						>
							{glyph}
							<span className="font-sans text-xs font-medium">{t(`modes.${mode}.short`)}</span>
						</button>
					</Tooltip>
				);
			})}
		</div>
	);
}

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
						className="inline-flex h-7 items-center rounded-md px-1.5 outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						<ContextRing value={usage.percent} showLabel={zone !== "normal"} />
					</button>
				</PopoverTrigger>
			</Tooltip>
			<PopoverContent width={280} side="top" align="end">
				<p className="text-md font-semibold text-fg">{t("context.title")}</p>
				<p className="mt-1 text-sm text-fg-muted">{t("context.body")}</p>
				<div className="mt-3 flex items-baseline justify-between text-sm">
					<span className="font-mono tabular-nums text-fg">
						{usage.tokens !== null ? formatTokens.format(usage.tokens) : "—"}
						<span className="text-fg-faint"> / {usage.contextWindow !== null ? formatTokens.format(usage.contextWindow) : "—"}</span>
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

chatSlots.register({ id: "composer.modes", placement: "composerTools", order: 30, component: ModeToggles });
chatSlots.register({ id: "composer.voice", placement: "composerTools", order: 50, component: VoiceTool });
chatSlots.register({ id: "composer.context", placement: "composerTools", order: 60, component: ContextTool });
