import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ZoomImage } from "../../panes/media";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { WaitingForSave } from "./shared";
import { usePreviewGrant } from "./usePreviewGrant";

export function Frame(props: LiveFrameProps) {
	const { t } = useTranslation("panes");
	const { frame, error } = usePreviewGrant(props);
	const [good, setGood] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!frame) return;
		let live = true;
		const image = new Image();
		const url = `${frame.grant.url}?rev=${frame.revision}`;
		image.onload = () => { if (live) { setGood(url); setFailed(false); } };
		image.onerror = () => { if (live) setFailed(true); };
		image.src = url;
		return () => { live = false; image.onload = null; image.onerror = null; };
	}, [frame]);
	return <div className="flex min-h-0 flex-1 flex-col">
		{good && <ZoomImage src={good} alt={props.subject.path?.split(/[\\/]/).pop() || t("live.imagePreview")} onError={() => setFailed(true)} />}
		{(error || failed) && <WaitingForSave />}
	</div>;
}

export const adapter: LiveAdapter = { format: "image", maxFps: 4, Frame };
