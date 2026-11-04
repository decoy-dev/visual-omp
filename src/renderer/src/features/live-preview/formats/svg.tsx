import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { closePartialSvg } from "../../../ui/charts/vendor/omp/svg-source";
import { sanitizeSvg, svgAccessibility, svgImage } from "../../../ui/diagram-source";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { Frame as ImageFrame } from "./image";
import { SizeNote, useFigurePalette, WaitingForSave } from "./shared";

function SourceFrame({ subject }: LiveFrameProps) {
	const { t } = useTranslation("chat");
	const { ref, palette } = useFigurePalette();
	const [good, setGood] = useState<{ src: string; name: string; description: string } | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (subject.elided) return;
		const repaired = closePartialSvg(subject.text ?? "");
		const clean = repaired === null ? null : sanitizeSvg(repaired, palette);
		if (!clean) { setFailed(true); return; }
		let live = true;
		const image = new Image();
		const src = svgImage(clean);
		image.onload = () => {
			if (live) { setGood({ src, ...svgAccessibility(clean) }); setFailed(false); }
		};
		image.onerror = () => { if (live) setFailed(true); };
		image.src = src;
		return () => { live = false; image.onload = null; image.onerror = null; };
	}, [subject.text, subject.elided, palette]);
	return <div ref={ref} className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
		{subject.elided ? <SizeNote /> : <>{good && <img src={good.src} alt={good.name || t("visual.svg")} aria-description={good.description || undefined} className="m-auto max-h-full max-w-full" onError={() => setFailed(true)} />}{failed && <WaitingForSave />}</>}
	</div>;
}

export function Frame(props: LiveFrameProps) {
	return props.subject.kind === "file" ? <ImageFrame {...props} /> : <SourceFrame {...props} />;
}

export const adapter: LiveAdapter = { format: "svg", maxFps: 8, Frame };
