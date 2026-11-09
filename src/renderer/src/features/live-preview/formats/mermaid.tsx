import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { sanitizeSvg, svgAccessibility, svgImage } from "../../../ui/diagram-source";
import { renderMermaid } from "../../../ui/mermaid-render";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { SizeNote, useFigurePalette, usePictureHeight, useSourceText, WaitingForSave } from "./shared";

interface RenderJob { text: string; palette: Readonly<Record<string, string>>; revision: number }

export function Frame({ subject, onHeight }: LiveFrameProps) {
	const { t } = useTranslation("chat");
	const { ref, palette } = useFigurePalette();
	usePictureHeight(ref, onHeight, true);
	const { text, error, tooLarge } = useSourceText(subject);
	const [good, setGood] = useState<{ src: string; name: string; description: string } | null>(null);
	const [failed, setFailed] = useState(false);
	const work = useRef<{ mounted: boolean; running: boolean; newest: RenderJob | null; pending: RenderJob | null }>({ mounted: true, running: false, newest: null, pending: null });
	useEffect(() => {
		work.current.mounted = true;
		return () => { work.current.mounted = false; work.current.pending = null; };
	}, []);
	useEffect(() => {
		const queue = work.current;
		if (subject.elided || text === null) { queue.newest = null; queue.pending = null; return; }
		const job: RenderJob = { text, palette, revision: subject.revision };
		queue.newest = job;
		queue.pending = job;
		const draw = () => {
			if (queue.running || !queue.pending || !queue.mounted) return;
			const next = queue.pending;
			queue.pending = null;
			queue.running = true;
			void renderMermaid(next.text, next.palette).then(svg => {
				if (!queue.mounted || queue.newest !== next) return;
				const clean = sanitizeSvg(svg, next.palette);
				if (!clean) throw new Error("Invalid SVG");
				setGood({ src: svgImage(clean), ...svgAccessibility(clean) });
				setFailed(false);
			}).catch(() => { if (queue.mounted && queue.newest === next) setFailed(true); }).finally(() => {
				queue.running = false;
				draw();
			});
		};
		draw();
	}, [text, subject.revision, subject.elided, palette]);
	return <div ref={ref} className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
		{subject.elided ? <SizeNote /> : <>{good && <img src={good.src} alt={good.name || t("visual.mermaid")} aria-description={good.description || undefined} className="block h-auto max-h-full w-full shrink-0 object-contain object-top" />}{(failed || error) && <WaitingForSave tooLarge={tooLarge} />}</>}
	</div>;
}

export const adapter: LiveAdapter = { format: "mermaid", maxFps: 8, Frame };
