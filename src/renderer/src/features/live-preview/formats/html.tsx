import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LiveAdapter, LiveFrameProps } from "../types";
import { Button, Segmented } from "../../../ui";
import { toast } from "../../../ui/toast";
import { SizeNote, WaitingForSave } from "./shared";
import { usePreviewGrant } from "./usePreviewGrant";

interface Slot { url: string; isolationTest?: true; complete: boolean; load: number }
type Zoom = "fit" | "actual" | "phone";

export function Frame(props: LiveFrameProps & { fileViewer?: boolean }) {
	const { t } = useTranslation("panes");
	const { grant, frame, error } = usePreviewGrant(props);
	const [slots, setSlots] = useState<[Slot | null, Slot | null]>([null, null]);
	const [visible, setVisible] = useState<number | null>(null);
	const [zoom, setZoom] = useState<Zoom>("fit");
	const [follow, setFollow] = useState(props.subject.state === "writing");
	const [requested, setRequested] = useState(0);
	const [bounds, setBounds] = useState({ width: 0, height: 0 });
	const viewport = useRef<HTMLDivElement>(null);
	const newest = useRef<string | null>(null);
	const shown = useRef<number | null>(null);
	const acceptedRequest = useRef(0);
	const writing = props.subject.state === "writing";
	const following = follow && writing;
	const shownUrl = visible === null ? null : slots[visible]?.url;
	const latestBase = frame ? `${frame.grant.url}?rev=${frame.revision}` : null;
	const outdated = Boolean(shownUrl && latestBase && (shownUrl.split("#")[0] !== latestBase || slots[visible!]?.complete !== !writing));
	useEffect(() => {
		const element = viewport.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => { if (!writing) setFollow(false); }, [writing]);
	useEffect(() => {
		const pauseForFrameFocus = () => {
			const active = document.activeElement;
			if (active instanceof HTMLIFrameElement && active.getAttribute("aria-hidden") === "false" && viewport.current?.contains(active)) setFollow(false);
		};
		window.addEventListener("blur", pauseForFrameFocus);
		return () => window.removeEventListener("blur", pauseForFrameFocus);
	}, []);
	useEffect(() => {
		if (!grant) return;
		return window.vomp.on("preview:blockedNavigation", ({ token, url }) => {
			if (token !== grant.token || !/^https?:\/\//i.test(url)) return;
			toast({ message: t("live.blockedNavigation"), description: url, action: { label: t("live.openBrowser"), onClick: () => { void window.vomp.invoke("app:openExternal", url); } } });
		});
	}, [grant, t]);
	useEffect(() => {
		if (!frame) return;
		const force = requested !== acceptedRequest.current;
		// Opaque frames cannot expose their scroll offset. Keep the reviewed document mounted when paused or finished.
		if (shown.current !== null && !following && requested === acceptedRequest.current && !frame.isolationTest) {
			newest.current = slots[shown.current]?.url ?? null;
			return;
		}
		acceptedRequest.current = requested;
		const url = `${frame.grant.url}?rev=${frame.revision}${following && frame.anchor ? `#${encodeURIComponent(frame.anchor)}` : ""}`;
		if (url === newest.current && !frame.isolationTest && !force) return;
		newest.current = url;
		const next = shown.current === 0 ? 1 : 0;
		setSlots(previous => {
			const slots: [Slot | null, Slot | null] = frame.isolationTest ? [null, null] : [...previous];
			slots[next] = { url, isolationTest: frame.isolationTest, complete: frame.saved, load: requested };
			return slots;
		});
	}, [frame, following, requested]);
	const resume = () => {
		if (following) { setFollow(false); return; }
		if (writing) setFollow(true);
		setRequested(value => value + 1);
	};
	const width = zoom === "phone" ? 390 : 1280;
	const scale = zoom === "actual" ? 1 : Math.min(1, (bounds.width || width) / width);
	if (props.subject.elided) return <SizeNote />;
	return <div className="flex min-h-0 flex-1 flex-col">
		<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-1.5">
			<Segmented<Zoom> size="sm" aria-label={t("live.htmlZoom")} value={zoom} onValueChange={value => { setZoom(value); setFollow(false); }} options={[
				{ value: "fit", label: t("live.htmlFit") }, { value: "actual", label: "100%" }, { value: "phone", label: t("live.htmlPhone") },
			]} />
			{(writing || outdated) && <Button size="sm" variant="ghost" aria-pressed={writing ? following : undefined} onClick={resume}>{t(writing ? following ? "live.htmlPauseFollow" : "live.htmlFollow" : "live.htmlLatest")}</Button>}
		</div>
		<div ref={viewport} className="relative min-h-0 flex-1 overflow-auto bg-inset" onKeyDownCapture={() => setFollow(false)}>
			{!frame && !error && <p role="status" className="p-3 text-sm text-fg-muted">{t("live.loading")}</p>}
			<div className="relative origin-top-left" style={{ width: width * scale, height: bounds.height || "100%" }}>
			{slots.map((slot, index) => slot && <iframe key={`${index}:${Boolean(slot.isolationTest)}:${slot.load}`} src={slot.url} sandbox={slot.isolationTest ? "allow-scripts" : ""} title={t("live.htmlPreview")} aria-hidden={visible !== index} tabIndex={visible === index ? 0 : -1} className="absolute left-0 top-0 origin-top-left border-0 bg-panel" style={{ width, height: bounds.height ? bounds.height / scale : "100%", transform: `scale(${scale})`, visibility: visible === index ? "visible" : "hidden" }} onLoad={() => {
				if (slot.url !== newest.current) return;
				shown.current = index;
				setVisible(index);
			}} />)}
			</div>
		</div>
		{(following || outdated) && <p role="status" className="border-t border-border px-2 py-1 text-xs text-fg-muted">{t(following ? "live.htmlFollowing" : "live.htmlPaused")}</p>}
		{!frame?.isolationTest && <p className="border-t border-border px-2 py-1.5 text-xs text-fg-muted">{t("live.htmlPolicy")}</p>}
		{grant?.assetRoot === false && <p className="px-2 py-1 text-xs text-fg-muted">{t(props.fileViewer ? "files.htmlRestrictedAssets" : "live.restrictedAssets")}</p>}
		{error && (props.fileViewer ? <p role="status" className="px-2 py-1.5 text-sm text-fg-muted">{t("files.htmlUnavailable")}</p> : <WaitingForSave />)}
	</div>;
}

export const adapter: LiveAdapter = { format: "html", maxFps: 4, Frame };
