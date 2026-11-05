import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../ui";
import { openInFiles } from "../../panes/files-store";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { WaitingForSave } from "./shared";
import { usePreviewGrant } from "./usePreviewGrant";

interface VideoRevision { url: string; revision: number }
interface KeyFrame { time: number; canvas: HTMLCanvasElement }

/** The end sample stays inside the final decodable frame, rather than seeking past it. */
export function keyFrameTimes(duration: number): number[] {
	if (!Number.isFinite(duration) || duration <= 0) return [];
	const end = Math.max(0, duration - Math.min(0.05, duration / 100));
	return Array.from({ length: 6 }, (_, index) => end * index / 5);
}

function timeLabel(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function Tile({ frame }: { frame: KeyFrame }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	useEffect(() => { canvas.current?.getContext("2d")?.drawImage(frame.canvas, 0, 0); }, [frame]);
	return <canvas ref={canvas} width={frame.canvas.width} height={frame.canvas.height} className="block h-auto w-full" aria-hidden="true" />;
}

/** Display-only canvases never read pixels or export a cross-origin video frame. */
function KeyFrames({ source, onSeek }: { source: VideoRevision; onSeek(time: number): void }) {
	const { t } = useTranslation("panes");
	const [frames, setFrames] = useState<KeyFrame[]>([]);
	const video = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		const media = video.current;
		if (!media) return;
		let active = true;
		let times: number[] = [];
		const collected: KeyFrame[] = [];
		const draw = () => {
			if (!active || collected.length >= times.length || media.readyState < 2 || media.seeking
				|| Math.abs(media.currentTime - times[collected.length]!) > 0.1) return;
			if (!media.videoWidth || !media.videoHeight) return;
			const canvas = document.createElement("canvas");
			const scale = 160 / Math.max(media.videoWidth, media.videoHeight);
			canvas.width = Math.max(1, Math.round(media.videoWidth * scale));
			canvas.height = Math.max(1, Math.round(media.videoHeight * scale));
			const context = canvas.getContext("2d");
			if (!context) return;
			try { context.drawImage(media, 0, 0, canvas.width, canvas.height); } catch { return; }
			collected.push({ time: times[collected.length]!, canvas });
			if (collected.length === times.length) setFrames([...collected]);
			else media.currentTime = times[collected.length]!;
		};
		const metadata = () => {
			times = keyFrameTimes(media.duration);
			if (times.length) media.currentTime = times[0]!;
		};
		media.addEventListener("loadedmetadata", metadata);
		media.addEventListener("loadeddata", draw);
		media.addEventListener("seeked", draw);
		media.src = source.url;
		media.load();
		return () => {
			active = false;
			media.removeEventListener("loadedmetadata", metadata);
			media.removeEventListener("loadeddata", draw);
			media.removeEventListener("seeked", draw);
			media.pause();
			media.removeAttribute("src");
			media.load();
		};
	}, [source.url]);
	return <>
		<video ref={video} hidden muted playsInline preload="metadata" data-keyframe-source="" />
		{frames.length > 0 && <div role="group" aria-label={t("live.keyFrames")} className="grid grid-cols-2 gap-2 p-2 @min-[28rem]/live:grid-cols-3">
			{frames.map((frame, index) => <button key={index} type="button" aria-label={t("live.seekFrame", { time: timeLabel(frame.time) })} onClick={() => onSeek(frame.time)}
				className="min-w-0 overflow-hidden rounded-sm border border-border text-xs text-fg-muted hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring">
				<Tile frame={frame} /><span className="block px-1 py-1 tabular-nums">{timeLabel(frame.time)}</span>
			</button>)}
		</div>}
	</>;
}

export function Frame(props: LiveFrameProps) {
	const { t } = useTranslation("panes");
	const { frame, error } = usePreviewGrant(props);
	const [good, setGood] = useState<VideoRevision | null>(null);
	const [failed, setFailed] = useState<"save" | "codec" | null>(null);
	const player = useRef<HTMLVideoElement>(null);
	const latest = frame ? `${frame.grant.url}?rev=${frame.revision}` : null;
	const newest = useRef(latest);
	newest.current = latest;
	const pending = latest && latest !== good?.url ? { url: latest, revision: frame!.revision } : null;
	const loadFailed = (media: HTMLVideoElement) => setFailed(media.error?.code === 4 ? "codec" : "save");
	return <div className="flex min-h-0 flex-1 flex-col">
		{good && <>
			<video key={`player:${good.url}`} ref={player} src={good.url} controls preload="metadata" muted playsInline aria-label={t("live.videoPreview")}
				className="block aspect-video w-full shrink-0 object-contain" onError={event => { if (good.url === newest.current) loadFailed(event.currentTarget); }} />
			<KeyFrames key={`frames:${good.url}`} source={good} onSeek={time => { if (player.current) player.current.currentTime = time; }} />
		</>}
		{pending && <video key={pending.url} src={pending.url} preload="auto" muted playsInline hidden data-pending-video=""
			onLoadedData={() => { if (newest.current === pending.url && pending.revision === props.subject.revision) { setGood(pending); setFailed(null); } }}
			onError={event => { if (newest.current === pending.url && pending.revision === props.subject.revision) loadFailed(event.currentTarget); }} />}
		{failed === "codec" && props.subject.state === "saved" ? <div role="status" className="p-2 text-sm text-fg-muted"><p>{t("live.videoUnsupported")}</p>
			{props.projectPath && props.subject.path && <Button size="sm" variant="ghost" onClick={() => openInFiles(props.projectPath!, props.subject.path!)}>{t("live.openFiles")}</Button>}
		</div> : (error || failed !== null) && <WaitingForSave />}
	</div>;
}

export const adapter: LiveAdapter = { format: "video", maxFps: 4, Frame };
