import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type VideoHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../ui";
import { useMotionReduced } from "../../../ui/motion";
import { openInFiles } from "../../panes/files-store";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { WaitingForSave } from "./shared";
import { usePreviewGrant } from "./usePreviewGrant";

const InputFrame = lazy(() => import("./image").then(module => ({ default: module.Frame })));
interface VideoRevision { url: string; revision: number; path: string | null; timeline: number }
interface KeyFrame { time: number; canvas: HTMLCanvasElement }
const PLAYBACK_KEYS: Record<string, true> = { ArrowLeft: true, ArrowRight: true, ArrowUp: true, ArrowDown: true, Home: true, End: true, " ": true, k: true, j: true, l: true };

/** Native pause can precede ended. An exact-end paused player must not pin an obsolete revision. */
function atPlaybackEnd(media: HTMLVideoElement): boolean {
	return media.ended || (media.paused && Number.isFinite(media.duration) && media.duration > 0
		&& media.currentTime >= media.duration - 0.001);
}

/** The end sample stays inside the final decodable frame, rather than seeking past it. */
export function keyFrameTimes(duration: number): number[] {
	if (!Number.isFinite(duration) || duration <= 0) return [];
	const end = Math.max(0, duration - Math.min(0.05, duration / 100));
	return Array.from({ length: 6 }, (_, index) => end * index / 5);
}

/** Follow the newest decodable frame while rendering; retain the person's position after completion. */
export function videoRevisionTime(duration: number, current: number, running: boolean): number {
	if (!Number.isFinite(duration) || duration <= 0) return 0;
	const end = Math.max(0, duration - Math.min(0.1, duration / 10));
	return running ? end : Math.min(end, Math.max(0, Number.isFinite(current) ? current : 0));
}

function timeLabel(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function Tile({ frame }: { frame: KeyFrame }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	useEffect(() => { canvas.current?.getContext("2d")?.drawImage(frame.canvas, 0, 0); }, [frame]);
	return <canvas ref={canvas} width={frame.canvas.width} height={frame.canvas.height} className="block aspect-video max-h-24 w-full object-contain" aria-hidden="true" />;
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
		{frames.length > 0 && <div role="group" aria-label={t("live.keyFrames")} className="grid shrink-0 grid-cols-3 gap-2 p-2">
			{frames.map((frame, index) => <button key={index} type="button" aria-label={t("live.seekFrame", { time: timeLabel(frame.time) })} onClick={() => onSeek(frame.time)}
				className="min-w-0 overflow-hidden rounded-sm border border-border text-xs text-fg-muted hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring">
				<Tile frame={frame} /><span className="block px-1 py-1 tabular-nums">{timeLabel(frame.time)}</span>
			</button>)}
		</div>}
	</>;
}

/**
 * Promotion keeps this component mounted. Only superseded media release their decoder and protocol stream.
 * The source is attached in the effect rather than as a JSX attribute: the cleanup removes it, and React
 * would not put an unchanged attribute back when an effect reruns on the same element (StrictMode does
 * this in development).
 */
function RevisionVideo({ source, nodes, ...props }: VideoHTMLAttributes<HTMLVideoElement> & {
	source: VideoRevision; nodes: Map<string, HTMLVideoElement>;
}) {
	const element = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		const media = element.current!;
		nodes.set(source.url, media);
		media.src = source.url;
		return () => {
			nodes.delete(source.url);
			media.pause();
			media.removeAttribute("src");
			media.load();
		};
	}, [nodes, source.url]);
	return <video {...props} ref={element} />;
}

export function Frame(props: LiveFrameProps) {
	const { t } = useTranslation("panes");
	const { frame, error } = usePreviewGrant(props);
	const [good, setGood] = useState<VideoRevision | null>(null);
	const [failed, setFailed] = useState<"save" | "codec" | null>(null);
	const reduced = useMotionReduced();
	const [following, setFollowing] = useState(true);
	const [requested, setRequested] = useState<string | null>(null);
	const nodes = useRef(new Map<string, HTMLVideoElement>());
	const controlsBusy = useRef(false);
	const viewport = useRef<HTMLDivElement>(null);
	const beforePlayer = useRef<HTMLDivElement>(null);
	const afterPlayer = useRef<HTMLDivElement>(null);
	const [playerSize, setPlayerSize] = useState<{ width: number; height: number } | null>(null);
	useLayoutEffect(() => {
		const element = viewport.current;
		if (!element) return;
		const measure = () => {
			const media = good && nodes.current.get(good.url);
			if (!media?.videoWidth || !media.videoHeight) return;
			const reserved = (beforePlayer.current?.clientHeight ?? 0) + (afterPlayer.current?.clientHeight ?? 0);
			const widthScale = element.clientWidth / media.videoWidth;
			const minimum = Math.min(media.videoHeight * widthScale, 8 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16));
			const height = Math.max(minimum, (props.availableHeight ?? element.clientHeight) - reserved);
			const scale = Math.min(widthScale, height / media.videoHeight);
			const width = media.videoWidth * scale, fittedHeight = media.videoHeight * scale;
			setPlayerSize(previous => previous?.width === width && previous.height === fittedHeight ? previous : { width, height: fittedHeight });
			props.onHeight?.(Math.ceil(reserved + fittedHeight), Math.ceil(reserved + minimum));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		if (beforePlayer.current) observer.observe(beforePlayer.current);
		if (afterPlayer.current) observer.observe(afterPlayer.current);
		return () => observer.disconnect();
	}, [good?.url, props.availableHeight, props.onHeight]);
	const running = props.subject.state === "running" || props.subject.state === "writing";
	const { id, toolCallId, startedAt, path, size } = props.subject;
	const timeline = useRef({ id, toolCallId, startedAt, path, size, running, generation: 0 });
	const previous = timeline.current;
	const restarted = previous.id !== id || previous.toolCallId !== toolCallId || previous.startedAt !== startedAt
		|| previous.path !== path || (!previous.running && running)
		// Before the first watcher snapshot, the decoder may still be showing last run's file.
		|| (running && previous.size === null && size !== null)
		|| (size !== null && previous.size !== null && size < previous.size);
	timeline.current = { id, toolCallId, startedAt, path, size, running, generation: previous.generation + (restarted ? 1 : 0) };
	const generation = timeline.current.generation;
	useEffect(() => { setFollowing(true); }, [id, toolCallId, startedAt, path]);
	const oldPlayer = good && nodes.current.get(good.url);
	const oldEnded = oldPlayer ? atPlaybackEnd(oldPlayer) : false;
	const follow = running && following && !reduced;
	const latest = frame ? `${frame.grant.url}?rev=${frame.revision}` : null;
	const newest = useRef(latest);
	newest.current = latest;
	const manual = reduced && requested === latest;
	const pending = latest && latest !== good?.url && (!good || ((following || oldEnded) && !reduced) || manual)
		? { url: latest, revision: frame!.revision, path: props.subject.path, timeline: generation } : null;
	const loadFailed = (media: HTMLVideoElement) => setFailed(media.error?.code === 4 ? "codec" : "save");
	const accept = (source: VideoRevision, media: HTMLVideoElement) => {
		if (newest.current !== source.url || source.revision !== props.subject.revision) return;
		const visible = good && nodes.current.get(good.url);
		const ended = visible ? atPlaybackEnd(visible) : false;
		if (visible && (controlsBusy.current || document.activeElement === visible
			|| ((!following || reduced) && !manual && !(ended && !reduced)))) return;
		// Only positions within one render timeline are ordered. A replaced file starts another timeline.
		if (visible && !Number.isFinite(media.duration) && media.currentTime === 0) return;
		if (visible && good.path === source.path && good.timeline === source.timeline && !ended
			&& media.currentTime < visible.currentTime) return;
		setGood(source);
		setFailed(null);
		setRequested(null);
		if (follow) void media.play().catch(() => {});
	};
	useEffect(() => {
		if (reduced && good) nodes.current.get(good.url)?.pause();
	}, [reduced, good]);
	// Keep the decoded element when promoting it. Recreating it would flash a blank player on every growth update.
	const sources = [good, pending].filter((source): source is VideoRevision => source !== null);
	return <div ref={viewport} className="flex min-h-0 flex-1 flex-col">
		<div ref={beforePlayer} className="shrink-0">
			{!following && !reduced && (running || latest !== good?.url) && <Button size="sm" variant="ghost" onClick={() => {
				controlsBusy.current = false;
				setFollowing(true);
			}}>{t("live.followRender")}</Button>}
			{reduced && good && latest && latest !== good.url && <Button size="sm" variant="ghost" onClick={() => {
				controlsBusy.current = false;
				nodes.current.get(good.url)?.pause();
				setRequested(latest);
			}}>{t("live.loadLatestVideo")}</Button>}
		</div>
		{!good && props.subject.videoFrame && <Suspense fallback={null}>
			<p className="px-2 py-1 text-xs text-fg-muted">{t("live.videoInputFrame")}</p>
			<InputFrame {...props} subject={{ ...props.subject, kind: "file", format: "image", path: props.subject.videoFrame.path, videoFrame: undefined }} />
		</Suspense>}
		{sources.map(source => {
			const visible = source.url === good?.url;
			return <RevisionVideo key={source.url} source={source} nodes={nodes.current} controls={visible}
				preload={visible ? "metadata" : "auto"} muted playsInline hidden={!visible}
				data-pending-video={visible ? undefined : ""} aria-label={visible ? t("live.videoPreview") : undefined}
				className="block max-w-full shrink-0 self-center object-contain" style={visible && playerSize ? playerSize : undefined}
				onLoadedData={event => {
					const visiblePlayer = good && nodes.current.get(good.url);
					const ended = visiblePlayer ? atPlaybackEnd(visiblePlayer) : false;
					if (visible || (good && (!following || reduced) && !manual && !(ended && !reduced))) return;
					const media = event.currentTarget;
					if (media.duration === 0) return;
					const current = good && good.path === source.path && good.timeline === source.timeline ? visiblePlayer?.currentTime ?? 0 : 0;
					const time = !Number.isFinite(media.duration) || (reduced && !manual) ? media.currentTime : videoRevisionTime(media.duration, current, follow && !manual);
					if (Math.abs(time - media.currentTime) > 0.05) media.currentTime = time;
					else accept(source, media);
				}}
				onSeeked={event => { if (!visible) accept(source, event.currentTarget); }}
				onFocus={() => { if (visible) controlsBusy.current = true; }}
				onBlur={() => {
					if (!visible) return;
					controlsBusy.current = false;
					const candidate = pending && nodes.current.get(pending.url);
					if (pending && candidate && candidate.readyState >= 2 && !candidate.seeking) accept(pending, candidate);
				}}
				onPointerDown={() => { if (visible) { controlsBusy.current = true; setFollowing(false); } }}
				onPointerUp={() => { if (visible) controlsBusy.current = document.activeElement === nodes.current.get(source.url); }}
				onKeyDown={event => {
					if (visible && PLAYBACK_KEYS[event.key]) setFollowing(false);
				}}
				onSeeking={() => { if (visible) setFollowing(false); }}
				onPause={event => {
					if (visible && nodes.current.get(source.url) === event.currentTarget && !atPlaybackEnd(event.currentTarget)) setFollowing(false);
				}}
				onError={event => { if (source.url === newest.current) loadFailed(event.currentTarget); }} />;
		})}
		<div ref={afterPlayer} className="shrink-0">
			{good && !running && <KeyFrames key={`frames:${good.url}`} source={good} onSeek={time => {
				setFollowing(false);
				const media = nodes.current.get(good.url);
				if (media) media.currentTime = time;
			}} />}
			{failed === "codec" && props.subject.state === "saved" ? <div role="status" className="p-2 text-sm text-fg-muted"><p>{t("live.videoUnsupported")}</p>
				{props.projectPath && props.subject.path && <Button size="sm" variant="ghost" onClick={() => openInFiles(props.projectPath!, props.subject.path!)}>{t("live.openFiles")}</Button>}
			</div> : (error || failed !== null) && <WaitingForSave />}
		</div>
	</div>;
}

export const adapter: LiveAdapter = { format: "video", maxFps: 4, Frame };
