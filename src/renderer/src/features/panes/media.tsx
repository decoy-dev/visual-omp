/**
 * Image and PDF views shared by the Outputs pane and the Files viewer: thumbnails read on demand through a small
 * shared cache, the PDF viewer frame, the expanded preview over the window and opening a file in its default app.
 */
import { ArrowSquareOut, ArrowsOut, FilePdf, FolderSimpleDashed, ImageBroken, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTrigger, IconButton, Spinner, toast } from "../../ui";
import { errorText } from "../extensions/format";
import { IMAGE_EXT, OPENABLE_EXT, PDF_EXT } from "./derive";

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
 * since its page view still works.
 */
export function PreviewImage({
	sourceKey,
	load,
	pdf,
	enabled,
	alt,
	explain = false,
	className,
}: {
	sourceKey: string;
	load(): Promise<string | null>;
	pdf: boolean;
	enabled: boolean;
	alt: string;
	explain?: boolean;
	className?: string;
}) {
	const { t } = useTranslation("panes");
	const src = useImageSource(sourceKey, load, enabled);
	const [broken, setBroken] = useState<string | null>(null);
	if (src === undefined) return <span className="sr-only">{t("outputs.loading")}</span>;
	if (src === null || broken === src) {
		if (pdf) return <FilePdf aria-hidden className="size-6 text-fg-faint" />;
		return <Unavailable message={t("outputs.unavailable")} explain={explain} />;
	}
	return <img src={src} alt={alt} onError={() => setBroken(src)} className={className} />;
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

const FIT_IMAGE = "m-auto max-h-full max-w-full object-contain";
const ACTUAL_IMAGE = "m-auto max-w-none shrink-0";

/**
 * "Expand preview": the same image or PDF in a layer over nearly the whole window, so a wide spread is not squeezed
 * into the dock. Esc or Close returns focus to the button (Radix). `render` draws the content and gets the image
 * class: fitted to the layer, or at actual size (scrolling) once the toggle is on. Open in default app needs an
 * allowed file type and Show in folder a path, as in the panes.
 */
export function ExpandPreview({ name, path, image, render }: { name: string; path: string | null; image: boolean; render(imageClass: string): ReactNode }) {
	const { t } = useTranslation("panes");
	const [actual, setActual] = useState(false);
	return (
		<Dialog onOpenChange={open => open && setActual(false)}>
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
						{image && <IconButton size="sm" label={t("files.actualSize")} icon={<MagnifyingGlassPlus />} pressed={actual} onClick={() => setActual(!actual)} />}
						{path && OPENABLE_EXT.test(path) && <IconButton size="sm" label={t("outputs.openDefault")} icon={<ArrowSquareOut />} onClick={() => openWithDefaultApp(path, t)} />}
						{path && <IconButton size="sm" label={revealLabel(t)} icon={<FolderSimpleDashed />} onClick={() => void window.vomp.invoke("app:showItem", path)} />}
					</>
				}
			>
				<div className={image ? "flex h-full overflow-auto rounded-md bg-inset" : "flex h-full flex-col overflow-hidden rounded-md bg-inset"}>
					{render(actual ? ACTUAL_IMAGE : FIT_IMAGE)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
