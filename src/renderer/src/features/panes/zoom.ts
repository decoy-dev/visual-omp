/**
 * Geometry for the click-to-zoom image view (`ZoomImage` in media.tsx). A scale is image pixels per CSS pixel of the
 * image's natural size: 1 is actual size. The view lays the image out at its scaled size inside a scrolling content
 * box, so a vector image is drawn again at each size instead of stretching a bitmap.
 */

export interface Size {
	width: number;
	height: number;
}

export interface Point {
	x: number;
	y: number;
}

/** Space kept around a fitted image, in CSS pixels. */
export const FIT_MARGIN = 16;
/** How much one step of the keyboard zoom (+ or -) multiplies the scale by. */
export const ZOOM_STEP = 1.5;

/**
 * The scale that fits `natural` inside `viewport` less {@link FIT_MARGIN} on each side. A raster image never grows past
 * actual size, since that only shows blurred pixels; a vector image fills the view, which is also how an SVG with
 * only a `viewBox` (no size of its own) gets a useful size.
 */
export function fitScale(natural: Size, viewport: Size, vector: boolean): number {
	if (natural.width <= 0 || natural.height <= 0) return 1;
	const room = Math.max(1, viewport.width - 2 * FIT_MARGIN) / natural.width;
	const scale = Math.min(room, Math.max(1, viewport.height - 2 * FIT_MARGIN) / natural.height);
	return vector ? scale : Math.min(scale, 1);
}

/** The most pixels the zoomed image's longer side may span, so a large photo never becomes an element the compositor struggles with. */
export const MAX_ZOOM_PIXELS = 20_000;

/**
 * The largest scale: eight times the fitted size or eight times actual size, whichever is larger, and never past
 * {@link MAX_ZOOM_PIXELS} on the image's longer side. The pixel ceiling wins over both allowances.
 */
export function maxScale(fit: number, natural: Size): number {
	return Math.min(Math.max(fit * 8, 8), MAX_ZOOM_PIXELS / Math.max(natural.width, natural.height, 1));
}

/**
 * Where a click on the fitted image zooms to: actual size when that magnifies at least 1.5 times, else twice the
 * fitted size (an image already near or above actual size, or a vector without a size of its own). Never past
 * {@link maxScale}; {@link clampScale} turns a result at or below the fit into "stay fitted".
 */
export function clickScale(fit: number, natural: Size): number {
	return Math.min(fit <= 1 / 1.5 ? 1 : fit * 2, maxScale(fit, natural));
}

/**
 * A requested scale within bounds: null (fitted) at or below the fitted scale, else at most {@link maxScale}. Zooming
 * out past the fitted size returns to fit, so the view has one resting state, and when the pixel ceiling leaves no room
 * above the fit (a view wider than the ceiling) the image stays fitted.
 */
export function clampScale(scale: number, fit: number, natural: Size): number | null {
	const max = maxScale(fit, natural);
	if (!Number.isFinite(scale) || scale <= fit * 1.001 || max <= fit * 1.001) return null;
	return Math.min(scale, max);
}

export interface ZoomLayout {
	/** The image's box at this scale. */
	width: number;
	height: number;
	/** Its offset in the content box, which centers it when it is smaller than the view. */
	left: number;
	top: number;
	/** The scrolling content box: the view's size, or the image's where that is larger. */
	contentWidth: number;
	contentHeight: number;
}

export function zoomLayout(natural: Size, viewport: Size, scale: number): ZoomLayout {
	const width = natural.width * scale;
	const height = natural.height * scale;
	const contentWidth = Math.max(viewport.width, width);
	const contentHeight = Math.max(viewport.height, height);
	return { width, height, left: (contentWidth - width) / 2, top: (contentHeight - height) / 2, contentWidth, contentHeight };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * The scroll position after a layout change that keeps the image point under `anchor` (a point in the view) under
 * it. A point outside the image anchors at the nearest edge, and the result stays within the new scroll range.
 */
export function anchoredScroll(anchor: Point, scroll: Point, from: ZoomLayout, to: ZoomLayout, viewport: Size): Point {
	const fx = clamp((scroll.x + anchor.x - from.left) / from.width, 0, 1);
	const fy = clamp((scroll.y + anchor.y - from.top) / from.height, 0, 1);
	return {
		x: clamp(to.left + fx * to.width - anchor.x, 0, to.contentWidth - viewport.width),
		y: clamp(to.top + fy * to.height - anchor.y, 0, to.contentHeight - viewport.height),
	};
}

/**
 * How much one Ctrl/Cmd+wheel event (a trackpad pinch arrives as one) multiplies the scale by. Line and page deltas
 * are converted to pixels, and one event changes the scale by at most a factor of about 1.65, so a mouse wheel's
 * large notches stay usable while a pinch's small deltas zoom smoothly.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
	const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
	return Math.exp(-clamp(pixels, -50, 50) * 0.01);
}
