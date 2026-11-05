import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { toast } from "../../../ui/toast";
import { SizeNote, WaitingForSave } from "./shared";
import { usePreviewGrant } from "./usePreviewGrant";

interface Slot { url: string; isolationTest?: true }

export function Frame(props: LiveFrameProps & { fileViewer?: boolean }) {
	const { t } = useTranslation("panes");
	const { grant, frame, error } = usePreviewGrant(props);
	const [slots, setSlots] = useState<[Slot | null, Slot | null]>([null, null]);
	const [visible, setVisible] = useState<number | null>(null);
	const newest = useRef<string | null>(null);
	const shown = useRef<number | null>(null);
	useEffect(() => {
		if (!grant) return;
		return window.vomp.on("preview:blockedNavigation", ({ token, url }) => {
			if (token !== grant.token || !/^https?:\/\//i.test(url)) return;
			toast({ message: t("live.blockedNavigation"), description: url, action: { label: t("live.openBrowser"), onClick: () => { void window.vomp.invoke("app:openExternal", url); } } });
		});
	}, [grant, t]);
	useEffect(() => {
		if (!frame) return;
		const url = `${frame.grant.url}?rev=${frame.revision}`;
		newest.current = url;
		const next = shown.current === 0 ? 1 : 0;
		setSlots(previous => {
			// Give the process-isolation probe exactly one fixture frame, including the save transition.
			const slots: [Slot | null, Slot | null] = frame.isolationTest ? [null, null] : [...previous];
			slots[next] = { url, isolationTest: frame.isolationTest };
			return slots;
		});
	}, [frame]);
	if (props.subject.elided) return <SizeNote />;
	return <div className="flex min-h-0 flex-1 flex-col">
		<div className="relative min-h-0 flex-1">
		{!frame && !error && <p role="status" className="p-3 text-sm text-fg-muted">{t("live.loading")}</p>}
		{slots.map((slot, index) => slot && <iframe key={`${index}:${Boolean(slot.isolationTest)}`} src={slot.url} sandbox={slot.isolationTest ? "allow-scripts" : ""} title={t("live.htmlPreview")} aria-hidden={visible !== index} className="absolute inset-0 h-full w-full border-0 bg-panel" style={{ visibility: visible === index ? "visible" : "hidden" }} onLoad={() => {
			if (slot.url !== newest.current) return;
			shown.current = index;
			setVisible(index);
		}} />)}
		</div>
		{!frame?.isolationTest && <p className="border-t border-border px-2 py-1.5 text-xs text-fg-muted">{t("live.htmlPolicy")}</p>}
		{grant?.assetRoot === false && <p className="px-2 py-1 text-xs text-fg-muted">{t(props.fileViewer ? "files.htmlRestrictedAssets" : "live.restrictedAssets")}</p>}
		{error && (props.fileViewer ? <p role="status" className="px-2 py-1.5 text-sm text-fg-muted">{t("files.htmlUnavailable")}</p> : <WaitingForSave />)}
	</div>;
}

export const adapter: LiveAdapter = { format: "html", maxFps: 4, Frame };
