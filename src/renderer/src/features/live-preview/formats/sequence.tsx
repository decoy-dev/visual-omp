import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DirEntry } from "@shared/ipc";
import type { PreviewSequencePattern } from "@shared/contracts/preview";
import { loadFileImage, PreviewImage } from "../../panes/media";
import { cn } from "../../../ui";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { Frame as ImageFrame } from "./image";

const frameOrder = new Intl.Collator(undefined, { numeric: true });

/** Keep the strip bounded and include only regular files from the declared naming pattern. */
export function recentSequenceFrames(entries: readonly DirEntry[], pattern: PreviewSequencePattern): DirEntry[] {
	const frames: DirEntry[] = [];
	for (const entry of entries) {
		if (entry.kind !== "file" || !entry.name.startsWith(pattern.prefix) || !entry.name.endsWith(pattern.suffix)) continue;
		const number = entry.name.slice(pattern.prefix.length, entry.name.length - pattern.suffix.length);
		if (!/^\d+$/.test(number) || (pattern.digits !== null && number.length !== pattern.digits)) continue;
		if (frames.length === 12 && frameOrder.compare(entry.name, frames[0].name) <= 0) continue;
		let index = frames.length;
		while (index > 0 && frameOrder.compare(entry.name, frames[index - 1].name) < 0) index--;
		frames.splice(index, 0, entry);
		if (frames.length > 12) frames.shift();
	}
	return frames;
}

/** Keep at least 6rem per thumbnail row after fitting the large frame. */
export function sequenceFrameCount(height: number, rem: number, previewHeight = height * 2 / 3): number {
	return 3 * Math.max(1, Math.min(4, Math.floor((height - previewHeight) / (6 * rem))));
}

export function Frame(props: LiveFrameProps) {
	const { t } = useTranslation("panes");
	const pattern = props.subject.sequence?.pattern;
	const key = JSON.stringify(pattern ?? null);
	const [recent, setRecent] = useState<{ key: string; frames: DirEntry[] } | null>(null);
	const [selected, setSelected] = useState<{ key: string; path: string } | null>(null);
	const viewport = useRef<HTMLDivElement>(null);
	const [bounds, setBounds] = useState({ width: 0, height: 0, rem: 16 });
	const [aspect, setAspect] = useState<{ path: string | null; width: number; ratio: number } | null>(null);
	const frames = recent?.key === key ? recent.frames : [];
	const path = selected?.key === key ? selected.path : props.subject.path;
	const previewHeight = Math.min(bounds.height * 2 / 3, aspect?.path === path ? Math.min(aspect.width, Math.max(0, bounds.width - 2 * bounds.rem)) / aspect.ratio + 2 * bounds.rem : Infinity);
	const capacity = bounds.height ? sequenceFrameCount(bounds.height, bounds.rem, previewHeight) : 12;
	useEffect(() => { if (frames.length > 1) props.onHeight?.(null); }, [frames.length > 1, props.onHeight]);
	useEffect(() => {
		const element = viewport.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setBounds({ width: element.clientWidth, height: element.clientHeight,
			rem: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16 }));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		if (!pattern) return;
		let current = true;
		void window.vomp.invoke("fs:list", pattern.folder).then(entries => {
			if (current) setRecent({ key, frames: recentSequenceFrames(entries, pattern) });
		}).catch(() => {});
		return () => { current = false; };
	}, [key, props.subject.revision]);
	return <div ref={viewport} className="flex min-h-0 flex-1 flex-col gap-2">
		<div className="flex min-h-0 flex-col" style={frames.length > 1 ? { height: bounds.height ? previewHeight : "66.666%", flexShrink: 0 } : { flex: 1 }} onLoadCapture={event => {
			const image = event.target;
			if (image instanceof HTMLImageElement && image.naturalWidth > 0 && image.naturalHeight > 0) setAspect({ path, width: image.naturalWidth, ratio: image.naturalWidth / image.naturalHeight });
		}}>
			<ImageFrame {...props} onHeight={frames.length > 1 ? undefined : props.onHeight} subject={path === props.subject.path ? props.subject : { ...props.subject, path }} />
		</div>
		{frames.length > 1 && <div role="group" aria-label={t("live.keyFrames")} className="grid min-h-0 flex-1 auto-rows-fr grid-cols-3 gap-2 p-2">
			{frames.slice(-capacity).map(entry => <button key={entry.path} type="button" title={entry.name} aria-label={entry.name} aria-pressed={path === entry.path}
				onClick={() => setSelected(entry.path === props.subject.path ? null : { key, path: entry.path })}
				className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-sm border text-xs text-fg-muted focus-visible:outline-2 focus-visible:outline-ring", path === entry.path ? "border-ring" : "border-border hover:border-border-strong")}>
				<PreviewImage sourceKey={`sequence:${entry.path}:${props.subject.revision}`} load={() => loadFileImage(entry.path)} pdf={false} enabled alt="" className="min-h-0 w-full flex-1 object-contain" />
				<span className="block w-full shrink-0 truncate px-1 py-1">{entry.name}</span>
			</button>)}
		</div>}
	</div>;
}

export const adapter: LiveAdapter = { format: "sequence", maxFps: 4, Frame };
