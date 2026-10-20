/**
 * Ping field: the Home screen's decorative background. omp works below the surface and a periscope sees for it, so
 * the backdrop is a sparse dot grid, dim enough to read as texture. Every few seconds one sonar ping sweeps out from a
 * random point; dots near the wavefront brighten and the narrow inner band answers in teal.
 *
 * Constraints: Canvas 2D only, aria-hidden and pointer-events-none. The vertical fade lives in the alpha math, never
 * in a CSS gradient or mask. Colors come from the --plot-dot and --plot-accent tokens. It renders at about 30fps, pauses
 * while hidden, offscreen or blurred for more than 10s, and draws one still frame when motion is reduced.
 */
import { cn, useMotionReduced } from "@/ui";
import { type ReactNode, useEffect, useRef } from "react";

const PITCH = 28;
const DOT_RADIUS = 1.1;
/** How much a dot grows at the ping's leading edge, in CSS px, so the sweep reads as a ring and not only a tint. */
const DOT_GROW = 0.9;
const MAX_DPR = 1.5;
const TAU = Math.PI * 2;

const PING_SPEED = 260;
const PING_MAX_RADIUS = 640;
const PING_BAND = 90;
const PING_INNER = 30;
const PING_FADE_START = PING_MAX_RADIUS * 0.75;
const PING_FIRST_DELAY = 1.2;
const PING_GAP_MIN = 6;
const PING_GAP_MAX = 10;
const ECHO_CHANCE = 0.3;
const ECHO_DELAY = 0.5;
const ECHO_SPEED_SCALE = 1.6;
const ECHO_CAP_SCALE = 0.5;
const NEUTRAL_PEAK = 0.28;

const BLUR_PAUSE_MS = 10_000;
/** Milliseconds between drawn frames, about 30fps. */
const FRAME_MS = 1000 / 30;
/** Steps between the dot color and the accent, precomputed so the per-dot loop never builds a string. */
const MIX_STEPS = 16;

const LIGHT = { base: 0.05, amp: 0.07, accentPeak: 0.7 };
const DARK = { base: 0.06, amp: 0.08, accentPeak: 0.75 };

type Ping = { active: boolean; x: number; y: number; start: number; speed: number; cap: number };

/** Resolve any CSS color string to sRGB channels by painting it into a 1x1 canvas. */
function toRgb(probe: CanvasRenderingContext2D, color: string): [number, number, number] {
	probe.clearRect(0, 0, 1, 1);
	probe.fillStyle = "#000";
	probe.fillStyle = color.trim() || "#000";
	probe.fillRect(0, 0, 1, 1);
	const d = probe.getImageData(0, 0, 1, 1).data;
	return [d[0], d[1], d[2]];
}

export function PingField({ className }: { className?: string }): ReactNode {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const reduced = useMotionReduced();

	useEffect(() => {
		const canvas = canvasRef.current;
		const parent = canvas?.parentElement;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !parent || !ctx) return;

		const probeCanvas = document.createElement("canvas");
		probeCanvas.width = 1;
		probeCanvas.height = 1;
		const probe = probeCanvas.getContext("2d", { willReadFrequently: true });

		let width = 0;
		let height = 0;
		let dots = new Float32Array(0); // x, y pairs in CSS px
		let falloff = new Float32Array(0);
		let dotCount = 0;

		const colors: string[] = new Array(MIX_STEPS + 1).fill("#000");
		let dark = false;

		const pings: Ping[] = [
			{ active: false, x: 0, y: 0, start: 0, speed: PING_SPEED, cap: 1 },
			{ active: false, x: 0, y: 0, start: 0, speed: PING_SPEED * ECHO_SPEED_SCALE, cap: ECHO_CAP_SCALE },
		];
		// Per frame: x, y, radius, fade, cap for each live ping.
		const pingState = new Float32Array(pings.length * 5);
		let nextPingAt = PING_FIRST_DELAY;

		let t = 0;
		let lastNow = 0;
		let sinceDraw = 0;
		let raf = 0;
		let running = false;
		let intersecting = true;
		let blurredLong = false;
		let blurTimer: number | undefined;

		function readColors() {
			dark = document.documentElement.dataset.theme === "dark";
			if (!canvas || !probe) return;
			const style = getComputedStyle(canvas);
			const dot = toRgb(probe, style.getPropertyValue("--plot-dot"));
			const accent = toRgb(probe, style.getPropertyValue("--plot-accent"));
			for (let k = 0; k <= MIX_STEPS; k++) {
				const m = k / MIX_STEPS;
				const r = Math.round(dot[0] + (accent[0] - dot[0]) * m);
				const g = Math.round(dot[1] + (accent[1] - dot[1]) * m);
				const b = Math.round(dot[2] + (accent[2] - dot[2]) * m);
				colors[k] = `rgb(${r} ${g} ${b})`;
			}
		}

		function resize() {
			if (!canvas || !ctx || !parent) return;
			width = parent.clientWidth;
			height = parent.clientHeight;
			const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
			canvas.width = Math.max(1, Math.round(width * dpr));
			canvas.height = Math.max(1, Math.round(height * dpr));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

			const x0 = (((width / 2) % PITCH) + PITCH) % PITCH;
			const y0 = PITCH / 2;
			const cols = width > x0 ? Math.floor((width - x0) / PITCH) + 1 : 0;
			const rows = height > y0 ? Math.floor((height - y0) / PITCH) + 1 : 0;
			dotCount = cols * rows;
			dots = new Float32Array(dotCount * 2);
			falloff = new Float32Array(dotCount);
			const fadeCenter = height * 0.28;
			let i = 0;
			for (let row = 0; row < rows; row++) {
				const y = y0 + row * PITCH;
				const c = Math.cos((Math.PI * (y - fadeCenter)) / (2 * height));
				const f = Math.min(1, Math.max(0.25, 0.25 + 0.75 * c * c));
				for (let col = 0; col < cols; col++) {
					dots[i * 2] = x0 + col * PITCH;
					dots[i * 2 + 1] = y;
					falloff[i] = f;
					i++;
				}
			}
		}

		function spawnPing() {
			const main = pings[0];
			const echo = pings[1];
			main.active = true;
			main.x = width * (0.2 + 0.6 * Math.random());
			main.y = height * (0.2 + 0.6 * Math.random());
			main.start = t;
			if (Math.random() < ECHO_CHANCE) {
				echo.active = true;
				echo.x = main.x;
				echo.y = main.y;
				echo.start = t + ECHO_DELAY;
			}
			nextPingAt = t + PING_GAP_MIN + Math.random() * (PING_GAP_MAX - PING_GAP_MIN);
		}

		/** Fill pingState for this frame and return how many pings are live. */
		function updatePings(): number {
			if (t >= nextPingAt) spawnPing();
			let live = 0;
			for (const p of pings) {
				if (!p.active || t < p.start) continue;
				const r = (t - p.start) * p.speed;
				if (r >= PING_MAX_RADIUS) {
					p.active = false;
					continue;
				}
				const fade = r > PING_FADE_START ? (PING_MAX_RADIUS - r) / (PING_MAX_RADIUS - PING_FADE_START) : 1;
				const o = live * 5;
				pingState[o] = p.x;
				pingState[o + 1] = p.y;
				pingState[o + 2] = r;
				pingState[o + 3] = fade;
				pingState[o + 4] = p.cap;
				live++;
			}
			return live;
		}

		function draw(time: number, live: number) {
			if (!ctx) return;
			ctx.clearRect(0, 0, width, height);
			const { base, amp, accentPeak } = dark ? DARK : LIGHT;
			const baseColor = colors[0];
			ctx.fillStyle = baseColor;
			let styled = false;
			for (let i = 0; i < dotCount; i++) {
				const x = dots[i * 2];
				const y = dots[i * 2 + 1];
				const v = 0.5 + 0.25 * Math.sin(x * 0.011 + time * 0.13) + 0.25 * Math.sin(y * 0.017 - time * 0.09 + x * 0.004);
				const a = falloff[i] * (base + amp * v);
				let alpha = a;
				let mix = 0;
				let grow = 0;
				for (let p = 0; p < live; p++) {
					const o = p * 5;
					const dx = x - pingState[o];
					const dy = y - pingState[o + 1];
					const behind = pingState[o + 2] - Math.sqrt(dx * dx + dy * dy);
					if (behind < 0 || behind > PING_BAND) continue;
					const fade = pingState[o + 3];
					const cap = pingState[o + 4];
					const u = behind / PING_BAND;
					const w = (1 - u * u * u * u) * fade; // ease-out-quart, peak at the leading edge
					let pa = a + (NEUTRAL_PEAK * cap - a) * w;
					let pm = 0;
					if (behind <= PING_INNER) {
						pm = (1 - behind / PING_INNER) * fade;
						pa += (accentPeak * cap - pa) * pm;
					}
					if (pa > alpha) alpha = pa;
					if (pm > mix) mix = pm;
					if (w > grow) grow = w;
				}
				const step = Math.round(mix * MIX_STEPS);
				if (step > 0) {
					ctx.fillStyle = colors[step];
					styled = true;
				} else if (styled) {
					ctx.fillStyle = baseColor;
					styled = false;
				}
				ctx.globalAlpha = alpha;
				ctx.beginPath();
				ctx.arc(x, y, DOT_RADIUS + DOT_GROW * grow, 0, TAU);
				ctx.fill();
			}
			ctx.globalAlpha = 1;
		}

		/** Repaint without advancing time (resize, theme change, reduced motion). */
		function drawStill() {
			if (reduced) draw(0, 0);
			else draw(t, updatePings());
		}

		function tick(now: number) {
			raf = requestAnimationFrame(tick);
			const step = Math.min(now - lastNow, 100);
			lastNow = now;
			t += step / 1000;
			// About 30fps on any display: draw once at least FRAME_MS has passed, whatever the refresh rate.
			sinceDraw += step;
			if (sinceDraw < FRAME_MS) return;
			sinceDraw %= FRAME_MS;
			draw(t, updatePings());
		}

		function syncRunning() {
			const should = !reduced && !document.hidden && intersecting && !blurredLong;
			if (should === running) return;
			running = should;
			if (running) {
				lastNow = performance.now();
				raf = requestAnimationFrame(tick);
			} else {
				cancelAnimationFrame(raf);
			}
		}

		function onBlur() {
			clearTimeout(blurTimer);
			blurTimer = window.setTimeout(() => {
				blurredLong = true;
				syncRunning();
			}, BLUR_PAUSE_MS);
		}

		function onFocus() {
			clearTimeout(blurTimer);
			blurredLong = false;
			syncRunning();
		}

		readColors();
		resize();
		drawStill();

		const resizeObserver = new ResizeObserver(() => {
			resize();
			drawStill();
		});
		resizeObserver.observe(parent);

		const themeObserver = new MutationObserver(() => {
			readColors();
			drawStill();
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

		let intersectionObserver: IntersectionObserver | undefined;
		if (!reduced) {
			intersectionObserver = new IntersectionObserver((entries) => {
				const entry = entries[entries.length - 1];
				if (entry) intersecting = entry.isIntersecting;
				syncRunning();
			});
			intersectionObserver.observe(canvas);
			document.addEventListener("visibilitychange", syncRunning);
			window.addEventListener("blur", onBlur);
			window.addEventListener("focus", onFocus);
			if (!document.hasFocus()) onBlur();
			syncRunning();
		}

		return () => {
			cancelAnimationFrame(raf);
			running = false;
			clearTimeout(blurTimer);
			resizeObserver.disconnect();
			themeObserver.disconnect();
			intersectionObserver?.disconnect();
			document.removeEventListener("visibilitychange", syncRunning);
			window.removeEventListener("blur", onBlur);
			window.removeEventListener("focus", onFocus);
		};
	}, [reduced]);

	return (
		<canvas
			ref={canvasRef}
			aria-hidden="true"
			className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
		/>
	);
}
