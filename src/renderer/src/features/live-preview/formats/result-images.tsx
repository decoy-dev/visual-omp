import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { ZoomImage } from "../../panes/media";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { usePictureHeight } from "./shared";

export function Frame({ subject, onHeight }: LiveFrameProps) {
	const { t } = useTranslation("panes");
	const viewport = useRef<HTMLDivElement>(null);
	usePictureHeight(viewport, onHeight, false, 192);
	return <div ref={viewport} className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-gutter:stable]">{subject.images?.map((image, index) => <div key={index} className="flex min-h-48 flex-1"><ZoomImage src={`data:${image.mimeType};base64,${image.data}`} alt={t("live.imagePreview")} verticalAlign="start" /></div>)}</div>;
}

export const adapter: LiveAdapter = { format: "result-images", maxFps: 4, Frame };
