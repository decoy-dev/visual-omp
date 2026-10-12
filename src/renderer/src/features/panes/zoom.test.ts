import { describe, expect, it } from "vitest";
import { anchoredScroll, clampScale, clickScale, FIT_MARGIN, fitScale, MAX_ZOOM_PIXELS, maxScale, wheelZoomFactor, zoomLayout } from "./zoom";

const view = { width: 432, height: 332 };

describe("fitScale", () => {
	it("fits inside the view less the margin, limited by the tighter side", () => {
		expect(fitScale({ width: 1920, height: 1080 }, view, false)).toBeCloseTo((432 - 2 * FIT_MARGIN) / 1920);
		expect(fitScale({ width: 1000, height: 3000 }, view, false)).toBeCloseTo((332 - 2 * FIT_MARGIN) / 3000);
	});

	it("never enlarges a raster image but lets a vector fill the view", () => {
		expect(fitScale({ width: 32, height: 32 }, view, false)).toBe(1);
		expect(fitScale({ width: 300, height: 75 }, view, true)).toBeCloseTo(400 / 300);
	});

	it("does not divide by a zero size", () => {
		expect(fitScale({ width: 0, height: 0 }, view, true)).toBe(1);
	});
});

describe("clickScale and clampScale", () => {
	const big = { width: 1920, height: 1080 };

	it("zooms a much reduced image to actual size, and one near or above actual size to twice the fit", () => {
		expect(clickScale(0.2, big)).toBe(1);
		expect(clickScale(0.8, big)).toBeCloseTo(1.6);
		expect(clickScale(1.33, { width: 300, height: 75 })).toBeCloseTo(2.66);
	});

	it("returns to fit at or below the fitted scale and stops at the maximum", () => {
		expect(clampScale(0.2, 0.2, big)).toBeNull();
		expect(clampScale(0.1, 0.2, big)).toBeNull();
		expect(clampScale(Number.NaN, 0.2, big)).toBeNull();
		expect(clampScale(0.5, 0.2, big)).toBe(0.5);
		expect(clampScale(100, 0.2, big)).toBe(maxScale(0.2, big));
	});

	it("allows eight times the fit or eight times actual size, whichever is larger", () => {
		expect(maxScale(0.2, big)).toBe(8);
		expect(maxScale(2, { width: 300, height: 75 })).toBe(16);
	});

	it("never lets the longer side pass 20,000 pixels, even in a wide view", () => {
		expect(maxScale(0.01, { width: 40_000, height: 10_000 })).toBe(0.5);
		// A click never zooms past the maximum.
		expect(clickScale(0.01, { width: 40_000, height: 10_000 })).toBe(0.5);
		const square = { width: 4000, height: 4000 };
		const fit = fitScale(square, { width: 4000, height: 4000 }, false);
		expect(fit).toBeCloseTo(0.992);
		const most = clampScale(100, fit, square) ?? 0;
		expect(zoomLayout(square, { width: 4000, height: 4000 }, most).width).toBe(MAX_ZOOM_PIXELS);
	});

	it("stays fitted when the ceiling leaves no room above the fit", () => {
		const strip = { width: 300, height: 75 };
		const fit = fitScale(strip, { width: 30_000, height: 8000 }, true);
		expect(maxScale(fit, strip)).toBeLessThan(fit);
		expect(clampScale(clickScale(fit, strip), fit, strip)).toBeNull();
		expect(clampScale(fit * 4, fit, strip)).toBeNull();
	});
});

describe("zoomLayout", () => {
	it("centers an image smaller than the view and grows the content box with a larger one", () => {
		expect(zoomLayout({ width: 200, height: 100 }, view, 1)).toEqual({ width: 200, height: 100, left: 116, top: 116, contentWidth: 432, contentHeight: 332 });
		expect(zoomLayout({ width: 1000, height: 200 }, view, 1)).toEqual({ width: 1000, height: 200, left: 0, top: 66, contentWidth: 1000, contentHeight: 332 });
	});
});

describe("anchoredScroll", () => {
	const natural = { width: 1920, height: 1080 };
	const fit = fitScale(natural, view, false);
	const fitted = zoomLayout(natural, view, fit);
	const actual = zoomLayout(natural, view, 1);

	it("keeps the image point under the pointer in place when zooming in from fit", () => {
		const anchor = { x: 300, y: 200 };
		const scroll = anchoredScroll(anchor, { x: 0, y: 0 }, fitted, actual, view);
		const before = { x: (anchor.x - fitted.left) / fitted.width, y: (anchor.y - fitted.top) / fitted.height };
		const after = { x: (scroll.x + anchor.x - actual.left) / actual.width, y: (scroll.y + anchor.y - actual.top) / actual.height };
		expect(after.x).toBeCloseTo(before.x);
		expect(after.y).toBeCloseTo(before.y);
	});

	it("keeps the anchor while zooming between two zoomed scales", () => {
		const double = zoomLayout(natural, view, 2);
		const anchor = { x: 100, y: 50 };
		const scroll = anchoredScroll(anchor, { x: 500, y: 300 }, actual, double, view);
		expect(scroll).toEqual({ x: (500 + 100) * 2 - 100, y: (300 + 50) * 2 - 50 });
	});

	it("clamps to the scroll range near the edges and anchors a point outside the image at its edge", () => {
		expect(anchoredScroll({ x: 2, y: 2 }, { x: 0, y: 0 }, fitted, actual, view)).toEqual({ x: 0, y: 0 });
		const corner = anchoredScroll({ x: 431, y: 331 }, { x: 0, y: 0 }, fitted, actual, view);
		expect(corner).toEqual({ x: 1920 - 432, y: 1080 - 332 });
	});
});

describe("wheelZoomFactor", () => {
	it("zooms in on a negative delta, out on a positive one, and limits a large notch", () => {
		expect(wheelZoomFactor(-10, 0)).toBeGreaterThan(1);
		expect(wheelZoomFactor(10, 0)).toBeLessThan(1);
		expect(wheelZoomFactor(-10, 0) * wheelZoomFactor(10, 0)).toBeCloseTo(1);
		expect(wheelZoomFactor(-1000, 0)).toBeCloseTo(Math.exp(0.5));
		expect(wheelZoomFactor(-3, 1)).toBeCloseTo(Math.exp(0.48));
	});
});
