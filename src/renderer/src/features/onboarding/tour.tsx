/**
 * First-run guided tour (DESIGN §4.2): a 5-step spotlight over shell regions that carry
 * `data-tour="sidebar|composer|permission|dock|statusbar"`. A step whose element isn't on screen
 * (e.g. no chat open yet, so no composer) shows its card centered over the dimmed window.
 */
import { ArrowRight } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { useApp } from "../../state/app";
import { Button, PresenceSwap, StepDots, spring } from "../../ui";

const STEPS = ["sidebar", "composer", "permission", "dock", "statusbar"] as const;
type StepId = (typeof STEPS)[number];
type Side = "right" | "left" | "above" | "below";

/** Where each card prefers to sit relative to its spotlight, first fit wins. */
const PLACEMENT: Record<StepId, readonly Side[]> = {
	sidebar: ["right", "below", "above"],
	composer: ["above", "below", "right"],
	permission: ["above", "right", "below"],
	dock: ["left", "below", "above"],
	statusbar: ["above", "below"],
};

const CARD_WIDTH = 320;
/** Spotlight cutout padding around the target (DESIGN: 8px). */
const SPOT_PAD = 8;
const GAP = 12;
const EDGE = 16;
/** Wait for the shell to paint before the automatic first-run start. */
const AUTO_START_DELAY_MS = 800;

const useTour = create<{ step: number | null }>(() => ({ step: null }));

/** What had focus when the tour started, so finishing can put it back. */
let returnFocusTo: HTMLElement | null = null;

/** Start (or restart) the tour from step 1. */
export function startTour(): void {
	if (useTour.getState().step === null) returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	useTour.setState({ step: 0 });
}

/** After the tour: back to what had focus before it (the Help button, say), else the message box if a chat is open. */
function restoreFocus(): void {
	const target = returnFocusTo?.isConnected && returnFocusTo !== document.body ? returnFocusTo : null;
	returnFocusTo = null;
	(target ?? document.querySelector<HTMLElement>('[data-tour="composer"] textarea'))?.focus();
}

let autoStarted = false;

interface Box {
	top: number;
	left: number;
	width: number;
	height: number;
}

function sameBox(a: Box | null, b: Box | null): boolean {
	if (!a || !b) return a === b;
	return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/** Live bounding box of `[data-tour=id]`, following layout changes (panels opening, resizes). */
function useTargetBox(id: StepId): Box | null {
	const [box, setBox] = useState<Box | null>(null);
	useLayoutEffect(() => {
		// Undefined until the first measure of this target, so a missing target clears the old box.
		let current: Box | null | undefined;
		const measure = () => {
			const element = document.querySelector(`[data-tour="${id}"]`);
			const rect = element?.getBoundingClientRect();
			const next = rect && rect.width > 0 && rect.height > 0 ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null;
			if (current !== undefined && sameBox(current, next)) return;
			current = next;
			setBox(next);
		};
		measure();
		// Targets can mount late or move with animated panels; a light poll catches both.
		const timer = setInterval(measure, 200);
		window.addEventListener("resize", measure);
		return () => {
			clearInterval(timer);
			window.removeEventListener("resize", measure);
		};
	}, [id]);
	return box;
}

function placeCard(spot: Box | null, cardHeight: number, sides: readonly Side[]): { top: number; left: number } {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
	const clampLeft = (left: number) => clamp(left, EDGE, vw - CARD_WIDTH - EDGE);
	const clampTop = (top: number) => clamp(top, EDGE, vh - cardHeight - EDGE);
	if (!spot) return { top: (vh - cardHeight) / 2, left: (vw - CARD_WIDTH) / 2 };
	const right = spot.left + spot.width;
	const bottom = spot.top + spot.height;
	for (const side of sides) {
		if (side === "right" && right + GAP + CARD_WIDTH <= vw - EDGE) return { left: right + GAP, top: clampTop(spot.top) };
		if (side === "left" && spot.left - GAP - CARD_WIDTH >= EDGE) return { left: spot.left - GAP - CARD_WIDTH, top: clampTop(spot.top) };
		if (side === "above" && spot.top - GAP - cardHeight >= EDGE) return { top: spot.top - GAP - cardHeight, left: clampLeft(spot.left) };
		if (side === "below" && bottom + GAP + cardHeight <= vh - EDGE) return { top: bottom + GAP, left: clampLeft(spot.left) };
	}
	// Target fills the window: float the card inside it.
	return { top: clampTop(spot.top + EDGE), left: clampLeft(spot.left + EDGE) };
}

/** Mounted once at the app root: auto-starts on first launch with omp present, renders the overlay. */
export function TourHost() {
	const step = useTour(state => state.step);
	const tourCompleted = useApp(state => state.prefs?.tourCompleted);
	const ompReady = useApp(state => Boolean(state.omp?.found && state.omp.supported));

	useEffect(() => {
		if (autoStarted || tourCompleted !== false || !ompReady) return;
		const timer = setTimeout(() => {
			autoStarted = true;
			startTour();
		}, AUTO_START_DELAY_MS);
		return () => clearTimeout(timer);
	}, [tourCompleted, ompReady]);

	if (step === null) return null;
	const id = STEPS[step];
	return id ? <TourOverlay step={step} id={id} /> : null;
}

function TourOverlay({ step, id }: { step: number; id: StepId }) {
	const { t } = useTranslation("onboarding");
	const target = useTargetBox(id);
	const card = useRef<HTMLDivElement>(null);
	const next = useRef<HTMLButtonElement>(null);
	const [cardHeight, setCardHeight] = useState(180);
	const last = step === STEPS.length - 1;
	// Per-step ids: while the step content swaps, the outgoing and incoming copies are both mounted.
	const idBase = useId();
	const titleId = `${idBase}-${id}-title`;
	const bodyId = `${idBase}-${id}-body`;
	// Direction of the step change, for the card's content slide: forward slides in from the right.
	const previous = useRef(step);
	const direction = step >= previous.current ? 1 : -1;
	useEffect(() => {
		previous.current = step;
	}, [step]);

	// Placement needs the card's real height, which changes as the incoming step's text replaces the outgoing one.
	useLayoutEffect(() => {
		const element = card.current;
		if (!element) return;
		const measure = () => setCardHeight(element.offsetHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		next.current?.focus();
	}, [step]);

	// The dock is usually closed on first launch; open it for its step and put it back afterwards.
	useEffect(() => {
		if (id !== "dock") return;
		const wasOpen = useApp.getState().dockOpen;
		if (!wasOpen) useApp.getState().toggleDock(true);
		return () => {
			if (!wasOpen) useApp.getState().toggleDock(false);
		};
	}, [id]);

	// Keep focus inside the tour: return it to the card if something outside grabs it.
	useEffect(() => {
		const returnFocus = (event: FocusEvent) => {
			if (card.current && event.target instanceof Node && !card.current.contains(event.target)) next.current?.focus();
		};
		document.addEventListener("focusin", returnFocus);
		return () => document.removeEventListener("focusin", returnFocus);
	}, []);

	const finish = () => {
		useTour.setState({ step: null });
		void useApp.getState().setPrefs({ tourCompleted: true });
		// The overlay unmounts with this state change; move focus once it is gone.
		requestAnimationFrame(restoreFocus);
	};
	const advance = () => (last ? finish() : useTour.setState({ step: step + 1 }));

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			finish();
		} else if (event.key === "ArrowRight") {
			event.preventDefault();
			advance();
		} else if (event.key === "ArrowLeft" && step > 0) {
			event.preventDefault();
			useTour.setState({ step: step - 1 });
		} else if (event.key === "Tab" && card.current) {
			const focusable = [...card.current.querySelectorAll<HTMLElement>("button")];
			const index = focusable.indexOf(document.activeElement as HTMLElement);
			const nextIndex = (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
			event.preventDefault();
			focusable[nextIndex]?.focus();
		}
	};

	const spot = target && {
		top: target.top - SPOT_PAD,
		left: target.left - SPOT_PAD,
		width: target.width + SPOT_PAD * 2,
		height: target.height + SPOT_PAD * 2,
	};
	const position = placeCard(spot, cardHeight, PLACEMENT[id]);

	return createPortal(
		<div className="fixed inset-0 z-(--z-palette)">
			{/* Blocks the app underneath; the scrim itself is the spotlight's giant shadow. */}
			<div className="absolute inset-0" aria-hidden />
			{spot ? (
				// `layout` moves and resizes the cutout with transforms (FLIP), so top/left/size never animate directly.
				<motion.div
					aria-hidden
					layout
					transition={{ layout: spring.gentle }}
					className="pointer-events-none absolute outline-2 outline-ring shadow-[0_0_0_9999px_var(--backdrop)]"
					style={{ ...spot, borderRadius: 12 }}
				/>
			) : (
				<div aria-hidden className="absolute inset-0 bg-backdrop" />
			)}
			<motion.div
				ref={card}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={bodyId}
				onKeyDown={onKeyDown}
				layout="position"
				initial={{ opacity: 0, y: 8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ layout: spring.gentle, y: spring.gentle }}
				className="absolute w-[320px] overflow-hidden rounded-lg border border-border bg-overlay p-4 text-fg shadow-(--shadow-overlay)"
				style={position}
			>
				<div className="relative">
					<PresenceSwap swapKey={id} variant="slide" direction={direction} mode="popLayout">
						<h2 id={titleId} className="text-base font-semibold text-fg">
							{t(`tour.steps.${id}.title`)}
						</h2>
						<p id={bodyId} className="mt-1.5 text-md text-fg-muted">
							{t(`tour.steps.${id}.body`)}
						</p>
					</PresenceSwap>
				</div>
				<div className="mt-4 flex items-center gap-3">
					<Button variant="ghost" size="sm" onClick={finish} className="-ml-2">
						{t("tour.skip")}
					</Button>
					<StepDots total={STEPS.length} current={step} className="mx-auto" />
					<Button ref={next} variant="primary" size="sm" iconRight={<ArrowRight aria-hidden />} onClick={advance}>
						{last ? t("tour.finish") : t("tour.next")}
					</Button>
				</div>
			</motion.div>
		</div>,
		document.body,
	);
}
