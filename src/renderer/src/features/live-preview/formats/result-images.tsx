import { useTranslation } from "react-i18next";
import { ZoomImage } from "../../panes/media";
import type { LiveAdapter, LiveFrameProps } from "../types";

export function Frame({ subject }: LiveFrameProps) {
	const { t } = useTranslation("panes");
	return <div className="flex min-h-0 flex-1 flex-col overflow-auto">{subject.images?.map((image, index) => <div key={index} className="flex min-h-48 flex-1"><ZoomImage src={`data:${image.mimeType};base64,${image.data}`} alt={t("live.imagePreview")} /></div>)}</div>;
}

export const adapter: LiveAdapter = { format: "result-images", maxFps: 4, Frame };
