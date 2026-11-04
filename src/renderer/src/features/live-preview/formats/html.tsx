import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { SizeNote, WaitingForSave } from "./shared";
import { usePreviewGrant } from "./usePreviewGrant";

export function Frame(props: LiveFrameProps) {
	const { t } = useTranslation("panes");
	const { grant, frame, error } = usePreviewGrant(props);
	const [slots, setSlots] = useState<[string | null, string | null]>([null, null]);
	const [visible, setVisible] = useState<number | null>(null);
	const newest = useRef<string | null>(null);
	const shown = useRef<number | null>(null);
	useEffect(() => {
		if (!frame) return;
		const url = `${frame.grant.url}?rev=${frame.revision}`;
		newest.current = url;
		const next = shown.current === 0 ? 1 : 0;
		setSlots(previous => {
			const slots: [string | null, string | null] = [...previous];
			slots[next] = url;
			return slots;
		});
	}, [frame]);
	if (props.subject.elided) return <SizeNote />;
	return <div className="flex min-h-0 flex-1 flex-col">
		<div className="relative min-h-0 flex-1">
		{slots.map((url, index) => url && <iframe key={index} src={url} sandbox="" title={t("live.htmlPreview")} aria-hidden={visible !== index} className="absolute inset-0 h-full w-full border-0 bg-panel" style={{ visibility: visible === index ? "visible" : "hidden" }} onLoad={() => {
			if (url !== newest.current) return;
			shown.current = index;
			setVisible(index);
		}} />)}
		</div>
		{grant?.assetRoot === false && <p className="px-2 py-1 text-xs text-fg-muted">{t("live.restrictedAssets")}</p>}
		{error && <WaitingForSave />}
	</div>;
}

export const adapter: LiveAdapter = { format: "html", maxFps: 4, Frame };
