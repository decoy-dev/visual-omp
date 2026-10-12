/**
 * Image and PDF views shared by the Outputs pane and the Files viewer: thumbnails read on demand through a small
 * shared cache, the click-to-zoom image view, the PDF viewer frame, the expanded preview over the window and opening a
 * file in its default app.
 */
import { ArrowSquareOut, ArrowsOut, FilePdf, FolderSimpleDashed, ImageBroken, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { type AnimationPlaybackControlsWithThen, animate } from "motion/react";
import { type ReactNode, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn, Dialog, DialogContent, DialogTrigger, IconButton, Spinner, spring, toast, useMotionReduced } from "../../ui";
import { focusRingInset } from "../../ui/styles";
import { errorText } from "../extensions/format";
import { IMAGE_EXT, OPENABLE_EXT, PDF_EXT } from "./derive";
import { anchoredScroll, clampScale, clickScale, fitScale, type Point, type Size, ZOOM_STEP, wheelZoomFactor, zoomLayout } from "./zoom";

// ── image loading ───────────────────────────────────────────────────────────────────────────────

const IMAGE_CACHE_LIMIT = 24;
/** Image sources by the caller's key; a key that names a new read (a reopened pane, a newer use) reads again. */
const imageCache = new Map<string, Promise<string | null>>();

function cachedImage(key: string, load: () => Promise<string | null>): Promise<string | null> {
	let pending = imageCache.get(key);
	if (!pending) {
		pending = load();
		imageCache.set(key, pending);
		for (const old of imageCache.keys()) {
			if (imageCache.size <= IMAGE_CACHE_LIMIT) break;
			imageCache.delete(old);
		}
	}
	return pending;
}

/**
 * A file's picture from disk: the operating system's thumbnail of a PDF's first page (null when it makes none), or
 * an image file as a data URL. Null for anything else or when the read fails.
 */
export async function loadFileImage(path: string): Promise<string | null> {
	if (PDF_EXT.test(path)) return window.vomp.invoke("panes:thumbnail", path).catch(() => null);
	if (!IMAGE_EXT.test(path)) return null;
	const file = await window.vomp.invoke("panes:readFile", path).catch(() => null);
	return file?.kind === "image" ? file.dataUrl : null;
}

/** `undefined` while loading (or before `enabled`), null when the image can't be shown. */
function useImageSource(sourceKey: string, load: () => Promise<string | null>, enabled: boolean): string | null | undefined {
	const [state, setState] = useState<{ key: string; src: string | null } | null>(null);
	// Callers rebuild `load` on every render; the key, not the function, says when the image changed.
	const latest = useRef(load);
	latest.current = load;
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		void cachedImage(sourceKey, latest.current).then(src => live && setState({ key: sourceKey, src }));
		return () => {
			live = false;
		};
	}, [enabled, sourceKey]);
	return state?.key === sourceKey ? state.src : undefined;
}

/** Becomes true once the element scrolls near view, so a long grid only reads the thumbnails on screen. */
export function useNearView<T extends Element>(): [RefObject<T | null>, boolean] {
	const ref = useRef<T>(null);
	const [seen, setSeen] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (seen || !element) return;
		const observer = new IntersectionObserver(entries => entries.some(entry => entry.isIntersecting) && setSeen(true), { rootMargin: "200px" });
		observer.observe(element);
		return () => observer.disconnect();
	}, [seen]);
	return [ref, seen];
}

/** Broken-image glyph; `explain` adds the failure as visible text (the larger view), else it is for screen readers. */
export function Unavailable({ message, explain }: { message: string; explain: boolean }) {
	return (
		<span className="flex flex-col items-center gap-2 text-center text-fg-faint">
			<ImageBroken aria-hidden className="size-5" />
			<span className={explain ? "text-sm text-fg-muted" : "sr-only"}>{message}</span>
		</span>
	);
}

/**
 * An image read through `load`, cached by `sourceKey`. `alt` is empty where the surrounding button already names the
 * image; `explain` shows the failure as text. A PDF without a thumbnail shows the PDF glyph instead of a failure,
 * since its page view still works. `zoom` shows the image in a {@link ZoomImage} (with the control when one is given),
 * and `className` then styles the image inside it.
 */
export function PreviewImage({
	sourceKey,
	load,
	pdf,
	enabled,
	alt,
	explain = false,
	className,
	zoom,
}: {
	sourceKey: string;
	load(): Promise<string | null>;
	pdf: boolean;
	enabled: boolean;
	alt: string;
	explain?: boolean;
	className?: string;
	zoom?: boolean | ZoomControl;
}) {
	const { t } = useTranslation("panes");
	const src = useImageSource(sourceKey, load, enabled);
	const [broken, setBroken] = useState<string | null>(null);
	if (src === undefined) return <span className="sr-only">{t("outputs.loading")}</span>;
	if (src === null || broken === src) {
		if (pdf) return <FilePdf aria-hidden className="size-6 text-fg-faint" />;
		return <Unavailable message={t("outputs.unavailable")} explain={explain} />;
	}
	if (zoom) return <ZoomImage src={src} alt={alt} className={className} control={zoom === true ? undefined : zoom} onError={() => setBroken(src)} />;
	return <img src={src} alt={alt} onError={() => setBroken(src)} className={className} />;
}

// ── zoom ────────────────────────────────────────────────────────────────────────────────────────

/** Lets a toolbar outside the image (Expand preview's header) show and toggle a {@link ZoomImage}'s zoom. */
export interface ZoomControl {
	zoomed: boolean;
	onZoomedChange(zoomed: boolean): void;
	/** Gets the image's toggle (zoom in at the view's center, or back to fit) while a ZoomImage is mounted, null after. */
	attach(toggle: (() => void) | null): void;
}

/** A click or tap that moves less than this many pixels zooms; a longer one is a drag. */
const DRAG_SLOP = 4;

/**
 * An image fitted to its view (DESIGN §3.7) that zooms where it is clicked: to actual size, or twice the fitted size
 * when actual size would not be larger. While zoomed, dragging or scrolling moves around it and a click without a drag
 * returns to fit. Ctrl/Cmd+wheel and trackpad pinches (which Chromium reports as Ctrl+wheel) zoom around the pointer.
 * The view is a focusable toggle: a click (including one from assistive technology, which zooms at the center), Enter
 * or Space toggles the zoom, + and - step it and 0 fits the image; Esc is left to the surrounding view. The image is
 * laid out at its scaled size instead of being scaled by a transform, so an SVG is drawn again at each size and stays
 * sharp. A click, key or toolbar toggle animates from the old box on the snappy spring (skipped under reduced motion);
 * wheel and pinch zooming follow the input directly, and any other change first stops a running animation.
 *
 * The root is a flex item that fills its flex container (`flex-1 self-stretch`), whose height must be definite.
 */
export function ZoomImage({ src, alt, className, control, onError }: { src: string; alt: string; className?: string; control?: ZoomControl; onError?(): void }) {
	const { t } = useTranslation("panes");
	const reduced = useMotionReduced();
	const hintId = useId();
	const viewRef = useRef<HTMLDivElement>(null);
	const imageRef = useRef<HTMLImageElement>(null);
	const [view, setView] = useState<Size | null>(null);
	const [loaded, setLoaded] = useState<{ src: string; size: Size } | null>(null);
	/** The zoomed scale, or null while fitted (the fitted scale follows the view's size). */
	const [zoom, setZoom] = useState<number | null>(null);
	const [dragging, setDragging] = useState(false);
	const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
	/** Set when a drag ends, so the click the browser sends after it does not toggle the zoom. */
	const dragged = useRef(false);
	/** Scroll position (and the image's box before the change, to animate from) for the layout effect after a zoom. */
	const pending = useRef<{ scroll: Point; from: DOMRect | null } | null>(null);
	/** The running move from the old box to the new one, if any. */
	const flight = useRef<AnimationPlaybackControlsWithThen | null>(null);

	const natural = loaded?.src === src ? loaded.size : null;
	const fit = natural && view ? fitScale(natural, view, src.startsWith("data:image/svg+xml")) : 1;
	const box = natural && view ? zoomLayout(natural, view, zoom ?? fit) : null;
	// The geometry as of the last change, so several wheel events between two renders each start from the one before.
	const latest = useRef({ natural, view, fit, zoom, box });
	latest.current = { natural, view, fit, zoom, box };

	/** Stops a running move and drops its transform, so the image sits at its laid-out box again. */
	const settle = () => {
		flight.current?.stop();
		flight.current = null;
		if (imageRef.current) imageRef.current.style.transform = "";
	};
	const zoomTo = (requested: number | null, anchor: Point | null, animated: boolean) => {
		const element = viewRef.current;
		const now = latest.current;
		if (!element || !now.natural || !now.view || !now.box) return;
		const next = requested === null ? null : clampScale(requested, now.fit, now.natural);
		if (next === now.zoom) return;
		// The box on screen now (mid-move included) is where a new move starts; the anchor math uses the laid-out box.
		const from = animated && !reduced ? (imageRef.current?.getBoundingClientRect() ?? null) : null;
		settle();
		const to = zoomLayout(now.natural, now.view, next ?? now.fit);
		const at = anchor ?? { x: now.view.width / 2, y: now.view.height / 2 };
		const scroll = pending.current?.scroll ?? { x: element.scrollLeft, y: element.scrollTop };
		pending.current = { scroll: anchoredScroll(at, scroll, now.box, to, now.view), from: pending.current?.from ?? from };
		latest.current = { ...now, zoom: next, box: to };
		setZoom(next);
	};
	const toggle = (anchor: Point | null) => {
		const now = latest.current;
		if (now.natural) zoomTo(now.zoom === null ? clickScale(now.fit, now.natural) : null, anchor, true);
	};
	/** The pointer's position in the view's visible area, or null over a scroll bar. */
	const pointIn = (element: HTMLElement, event: { clientX: number; clientY: number }): Point | null => {
		const rect = element.getBoundingClientRect();
		const x = event.clientX - rect.left - element.clientLeft;
		const y = event.clientY - rect.top - element.clientTop;
		return x < element.clientWidth && y < element.clientHeight ? { x, y } : null;
	};

	useLayoutEffect(() => {
		const element = viewRef.current;
		if (!element) return;
		const measure = () =>
			setView(old => (old?.width === element.clientWidth && old.height === element.clientHeight ? old : { width: element.clientWidth, height: element.clientHeight }));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs after each zoom change, reading the job zoomTo left
	useLayoutEffect(() => {
		const job = pending.current;
		const element = viewRef.current;
		const image = imageRef.current;
		if (!job || !element) return;
		pending.current = null;
		element.scrollLeft = job.scroll.x;
		element.scrollTop = job.scroll.y;
		const to = image?.getBoundingClientRect();
		if (!job.from || !image || !to?.width) return;
		// From the old box to the new one (the transform origin is the image's top left corner). The spring drives one
		// progress value and this code writes the transform, so stopping the move leaves no frame to clear up after.
		const dx = job.from.left - to.left;
		const dy = job.from.top - to.top;
		const ds = job.from.width / to.width;
		const move = animate(0, 1, {
			...spring.snappy,
			onUpdate: progress => {
				const rest = 1 - progress;
				image.style.transform = `translate(${dx * rest}px, ${dy * rest}px) scale(${1 + (ds - 1) * rest})`;
			},
		});
		flight.current = move;
		void move.then(() => {
			if (flight.current !== move) return;
			flight.current = null;
			image.style.transform = "";
		});
	}, [zoom]);

	// A new image, a change of the motion setting or unmounting stops a running move.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `src` and `reduced` are the triggers; settle reads refs only
	useEffect(() => () => settle(), [src, reduced]);

	// Ctrl/Cmd+wheel needs a listener that isn't passive, so it can keep the page from handling the gesture.
	const onWheel = useRef((_event: WheelEvent) => {});
	onWheel.current = event => {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		const element = viewRef.current;
		const now = latest.current;
		if (element) zoomTo((now.zoom ?? now.fit) * wheelZoomFactor(event.deltaY, event.deltaMode), pointIn(element, event), false);
	};
	useEffect(() => {
		const element = viewRef.current;
		if (!element) return;
		const listener = (event: WheelEvent) => onWheel.current(event);
		element.addEventListener("wheel", listener, { passive: false });
		return () => element.removeEventListener("wheel", listener);
	}, []);

	const zoomed = zoom !== null;
	const report = control?.onZoomedChange;
	useEffect(() => report?.(zoomed), [report, zoomed]);
	const toggleRef = useRef(toggle);
	toggleRef.current = toggle;
	const attach = control?.attach;
	useEffect(() => {
		if (!attach) return;
		attach(() => toggleRef.current(null));
		return () => attach(null);
	}, [attach]);

	return (
		<div
			ref={viewRef}
			role="button"
			tabIndex={0}
			aria-pressed={zoomed}
			aria-label={t("files.zoomImage", { name: alt })}
			aria-describedby={hintId}
			aria-keyshortcuts="Enter + - 0"
			className={cn(
				"relative min-h-0 min-w-0 flex-1 self-stretch overscroll-contain select-none",
				zoomed ? "overflow-auto" : "overflow-hidden",
				dragging ? "cursor-grabbing" : zoomed ? "cursor-zoom-out" : "cursor-zoom-in",
				focusRingInset,
			)}
			onPointerDown={event => {
				const element = event.currentTarget;
				dragged.current = false;
				if (event.button !== 0 || !pointIn(element, event)) return;
				drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop, moved: false };
				element.setPointerCapture(event.pointerId);
			}}
			onPointerMove={event => {
				const current = drag.current;
				if (current?.id !== event.pointerId) return;
				const dx = event.clientX - current.x;
				const dy = event.clientY - current.y;
				if (!current.moved) {
					if (Math.hypot(dx, dy) < DRAG_SLOP) return;
					current.moved = true;
					settle();
					setDragging(zoomed);
				}
				if (!zoomed) return;
				event.currentTarget.scrollLeft = current.left - dx;
				event.currentTarget.scrollTop = current.top - dy;
			}}
			onPointerUp={event => {
				const current = drag.current;
				if (current?.id !== event.pointerId) return;
				drag.current = null;
				dragged.current = current.moved;
				setDragging(false);
			}}
			onPointerCancel={() => {
				drag.current = null;
				setDragging(false);
			}}
			onClick={event => {
				// A click from assistive technology (or `element.click()`) has no pointer position and zooms at the center.
				if (event.detail === 0) return toggle(null);
				if (dragged.current) {
					dragged.current = false;
					return;
				}
				// A press on a scroll bar is not a click on the image.
				const at = pointIn(event.currentTarget, event);
				if (at) toggle(at);
			}}
			onKeyDown={event => {
				if (event.metaKey || event.ctrlKey || event.altKey) return;
				const scale = zoom ?? fit;
				if (event.key === "Enter" || event.key === " ") toggle(null);
				else if (event.key === "+" || event.key === "=") zoomTo(scale * ZOOM_STEP, null, true);
				else if (event.key === "-" || event.key === "_") zoomTo(scale / ZOOM_STEP, null, true);
				else if (event.key === "0") zoomTo(null, null, true);
				else return;
				event.preventDefault();
			}}
		>
			<span id={hintId} className="sr-only">
				{t("files.zoomHint")}
			</span>
			{/* Positioned, so the content never sizes the view it is measured against; it still scrolls inside it. */}
			<div className="absolute top-0 left-0" style={box ? { width: box.contentWidth, height: box.contentHeight } : undefined}>
				<img
					ref={imageRef}
					src={src}
					alt={alt}
					draggable={false}
					// An SVG without a size of its own reports the CSS default object size (300×150, or 300 wide at its
					// viewBox's aspect ratio); fitScale lets a vector fill the view whatever that size is.
					onLoad={event => setLoaded({ src, size: { width: event.currentTarget.naturalWidth || 300, height: event.currentTarget.naturalHeight || 150 } })}
					onError={onError}
					className={cn("absolute max-w-none origin-top-left", !box && "invisible", className)}
					style={box ? { left: box.left, top: box.top, width: box.width, height: box.height } : undefined}
				/>
			</div>
		</div>
	);
}

/** A 4:3 thumbnail frame on `--bg-inset` with a small "PDF" marker on PDFs. */
export function ThumbnailFrame({ pdf, children }: { pdf: boolean; children: ReactNode }) {
	const { t } = useTranslation("panes");
	return (
		<span className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-sm border border-border bg-inset">
			{children}
			{pdf && (
				<span aria-hidden className="absolute bottom-1 left-1 rounded-sm bg-panel px-1 text-[10px] leading-4 font-semibold text-fg-muted">
					{t("outputs.pdf")}
				</span>
			)}
		</span>
	);
}

// ── PDF viewer ──────────────────────────────────────────────────────────────────────────────────

/**
 * The PDF's bytes as a Blob URL in Chromium's built-in viewer. A new `revision` reads it again; the shown page stays
 * until the new bytes arrive, and each Blob URL is revoked once it is replaced or the view closes.
 */
export function PdfFrame({ path, revision, name }: { path: string; revision: number; name: string }) {
	const { t } = useTranslation("panes");
	const [state, setState] = useState<{ path: string; url: string | null } | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is a reload trigger
	useEffect(() => {
		let live = true;
		window.vomp
			.invoke("panes:readPdf", path)
			.then(bytes => live && setState({ path, url: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })) }))
			.catch(() => live && setState({ path, url: null }));
		return () => {
			live = false;
		};
	}, [path, revision]);
	const url = state?.url ?? null;
	useEffect(
		() => () => {
			if (url) URL.revokeObjectURL(url);
		},
		[url],
	);
	const current = state?.path === path ? state : null;
	if (!current) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-muted" role="status">
				<Spinner /> {t("outputs.loadingPdf")}
			</div>
		);
	}
	if (!current.url) {
		return (
			<div className="flex flex-1 items-center justify-center p-4">
				<Unavailable message={t("outputs.pdfUnavailable")} explain />
			</div>
		);
	}
	// Chromium's viewer reads Adobe open parameters from the fragment: `navpanes=0` keeps the page-thumbnail sidebar
	// closed (its toolbar stays), and `view=FitH` fits the page to the frame's width, so a wide spread fills the view.
	return <iframe src={`${current.url}#navpanes=0&view=FitH`} title={t("outputs.pdfFrame", { name })} className="min-h-0 w-full flex-1 border-0" />;
}

// ── actions ─────────────────────────────────────────────────────────────────────────────────────

/** Opens a raster image or PDF in its default app; main refuses anything else (`panes:openOutput`). */
export function openWithDefaultApp(path: string, t: (key: string) => string): void {
	window.vomp.invoke("panes:openOutput", path).catch((error: unknown) => toast({ tone: "err", message: t("outputs.openFailed"), description: errorText(error) }));
}

/** "Show file in Finder" on macOS, else "Show file in folder". */
export function revealLabel(t: (key: string) => string): string {
	return t(window.vomp.platform === "darwin" ? "files.revealMac" : "files.reveal");
}

// ── expanded preview ────────────────────────────────────────────────────────────────────────────

/**
 * "Expand preview": the same image or PDF in a layer over nearly the whole window, so a wide spread is not squeezed
 * into the dock. Esc or Close returns focus to the button (Radix). `render` draws the content; an image goes in a
 * {@link ZoomImage} driven by the given control, which the header's "Zoom in" toggle shares, so a click on the image
 * and the toggle change the same zoom. The toggle is disabled while no image is shown (loading, or an image that
 * could not be drawn). Each opening starts fitted. Open in default app needs an allowed file type and Show in folder a
 * path, as in the panes.
 */
export function ExpandPreview({ name, path, image, render }: { name: string; path: string | null; image: boolean; render(zoom: ZoomControl): ReactNode }) {
	const { t } = useTranslation("panes");
	const [zoomed, setZoomed] = useState(false);
	const [toggle, setToggle] = useState<(() => void) | null>(null);
	const attach = useCallback((next: (() => void) | null) => {
		setToggle(() => next);
		if (!next) setZoomed(false);
	}, []);
	return (
		<Dialog onOpenChange={open => open && setZoomed(false)}>
			<DialogTrigger asChild>
				<IconButton size="sm" label={t("files.expand")} icon={<ArrowsOut />} />
			</DialogTrigger>
			<DialogContent
				size="full"
				title={
					<span className="block truncate" title={path ?? name}>
						{name}
					</span>
				}
				actions={
					<>
						{image && <IconButton size="sm" label={t("files.zoom")} icon={<MagnifyingGlassPlus />} pressed={zoomed} disabled={!toggle} onClick={() => toggle?.()} />}
						{path && OPENABLE_EXT.test(path) && <IconButton size="sm" label={t("outputs.openDefault")} icon={<ArrowSquareOut />} onClick={() => openWithDefaultApp(path, t)} />}
						{path && <IconButton size="sm" label={revealLabel(t)} icon={<FolderSimpleDashed />} onClick={() => void window.vomp.invoke("app:showItem", path)} />}
					</>
				}
			>
				<div className={cn("flex h-full overflow-hidden rounded-md bg-inset", image ? "items-center justify-center" : "flex-col")}>
					{render({ zoomed, onZoomedChange: setZoomed, attach })}
				</div>
			</DialogContent>
		</Dialog>
	);
}
