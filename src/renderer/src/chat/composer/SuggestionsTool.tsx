import { Check, Minus, TextAa } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useVisualSnapshot } from "../../state/visualSnapshot";
import { useTranslation } from "react-i18next";
import type { ChatSlotProps } from "../../registry/slots";
import { ipcErrorMessage, useResource } from "../../features/manage/shared";
import { rowPicker } from "../../ui/styles";
import { cn, toast, Tooltip } from "../../ui";

export function SuggestionsTool({ session }: ChatSlotProps) {
	const { t } = useTranslation("composer");
	const view = useVisualSnapshot(session.subscribe, session.getSnapshot);
	const cwd = session.projectPath;
	const setting = useResource(() => window.vomp.invoke("config:get", "composer.predictions", cwd), [cwd]);
	const [saving, setSaving] = useState(false);
	const { reload } = setting;
	useEffect(() => {
		void window.vomp.invoke("config:watch", cwd).catch(() => {});
		const off = window.vomp.on("config:changed", event => {
			if (event.scope === "global" || event.cwd === cwd) void reload();
		});
		return () => { off(); void window.vomp.invoke("config:unwatch", cwd).catch(() => {}); };
	}, [cwd, reload]);
	const enabled = setting.data?.value === true;
	const controlled = !!setting.data && setting.data.source !== "default" && setting.data.source !== "global";
	const unavailable = setting.loading || !!setting.error || !setting.data;
	const state = t(unavailable ? "suggestions.unknown" : enabled ? "suggestions.on" : "suggestions.off");
	const tip = `${t("suggestions.title")}: ${state}. ${setting.error ? t("suggestions.loadFailed", { reason: setting.error }) : `${t("suggestions.tip")} ${controlled ? t("suggestions.controlled") : t("suggestions.live")}`}`;
	const toggle = async () => {
		if (saving || unavailable || controlled || view.readOnly) return;
		setSaving(true);
		try {
			const result = await window.vomp.invoke("config:set", "composer.predictions", !enabled, "global", cwd);
			setting.setData(result.setting);
		} catch (error) {
			toast({ tone: "err", message: t("suggestions.saveFailed"), description: ipcErrorMessage(error) });
		} finally { setSaving(false); }
	};
	return <Tooltip content={tip}>
		<button type="button" aria-label={t("suggestions.label")} aria-description={tip} aria-pressed={enabled} aria-disabled={controlled || saving || undefined} aria-busy={saving || setting.loading} disabled={view.readOnly || unavailable} onClick={() => void toggle()} className={cn(rowPicker, "relative size-7 shrink-0 justify-center aria-pressed:bg-selected aria-pressed:text-accent [&]:px-0", controlled && "opacity-45")}>
			<TextAa className="size-4 shrink-0" aria-hidden />
			<span className="absolute -right-0.5 -bottom-0.5 flex size-3 items-center justify-center rounded-full bg-panel" aria-hidden>
				{enabled ? <Check className="size-2.5" /> : <Minus className="size-2.5" />}
			</span>
		</button>
	</Tooltip>;
}
