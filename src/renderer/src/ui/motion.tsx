/**
 * Motion presets and reusable motion components (DESIGN §1.12). Built on `motion/react`.
 *
 * Rules:
 * - Chrome (menus, tabs, dialogs, lists) uses `spring.snappy` or `spring.gentle`, both critically damped: no bounce.
 * - Tween-only properties (opacity, color) use `ease.outQuart`; long entrances may use `ease.outExpo`.
 * - Reduced motion is decided by `MotionProvider` from the app setting. Under it, motion skips transform and layout
 *   animations and keeps opacity, so every entrance degrades to a crossfade and every layout change is instant.
 * - A reveal never hides content that would be visible without the animation. Content rendered with the app's first
 *   paint, or already in a list when the list mounts, renders at rest. Entrances run only for content inserted later
 *   (a new message, a new list item, a surface opened by the user) or when a caller opts in with `animateOnMount`.
 *   No entrance depends on scroll or viewport triggers.
 *
 * Shared-element transitions: give the moving element a `layoutId` that is unique to its component instance (derive it
 * from `useId()`), so two instances on screen never trade elements. Tabs and Segmented in this folder do exactly that
 * for their indicators. `<LayoutGroup id>` (from "motion/react") is the alternative when several components must
 * coordinate one layout animation. Keep `layoutId` elements free of `transform` utilities; motion owns their transform
 * while it animates.
 */
import {
	AnimatePresence,
	type HTMLMotionProps,
	MotionConfig,
	motion,
	type Transition,
	useReducedMotionConfig,
	type Variants,
} from "motion/react";
import { createContext, type ReactNode, type RefObject, useContext, useEffect, useRef, useState } from "react";
import { pinnedAfterScroll, ScrollLedger } from "./scrollFollow";

/** Cubic-bezier presets, matching `--ease-out-quart` and `--ease-out-expo` in tokens.css. */
export const ease = {
	outQuart: [0.25, 1, 0.5, 1],
	outExpo: [0.16, 1, 0.3, 1],
} as const;

/** Critically damped springs (bounce 0). `visualDuration` is roughly when the motion looks finished. */
export const spring = {
	/** Indicators, toggles, menus, small surfaces. */
	snappy: { type: "spring", visualDuration: 0.22, bounce: 0 },
	/** Dialogs, sheets, list entrances, height changes. */
	gentle: { type: "spring", visualDuration: 0.4, bounce: 0 },
} as const satisfies Record<string, Transition>;

/** Tween durations in seconds, matching `--dur-*` in tokens.css. */
export const duration = {
	fast: 0.1,
	base: 0.16,
	slow: 0.24,
	xl: 0.36,
} as const;

const fade: Transition = { duration: duration.base, ease: ease.outQuart };
const fadeOut: Transition = { duration: duration.fast, ease: "easeIn" };

type ReducedMotionSetting = "always" | "never" | "user";

/** `data-motion` on <html> (set in App from the app setting): reduced → always, full → never, absent → follow the OS. */
function readReducedMotion(): ReducedMotionSetting {
	const value = document.documentElement.dataset.motion;
	if (value === "reduced") return "always";
	if (value === "full") return "never";
	return "user";
}

/** False during the app's first render, true afterwards. Entrances only run for content mounted once this is true. */
const AppSettled = createContext(false);

/** Mount once at the root. Ties motion's reduced-motion handling to the app setting and sets the default transition. */
export function MotionProvider({ children }: { children: ReactNode }) {
	const [reducedMotion, setReducedMotion] = useState(readReducedMotion);
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		const html = document.documentElement;
		const observer = new MutationObserver(() => setReducedMotion(readReducedMotion()));
		observer.observe(html, { attributes: true, attributeFilter: ["data-motion"] });
		setReducedMotion(readReducedMotion());
		setSettled(true);
		return () => observer.disconnect();
	}, []);
	return (
		<AppSettled.Provider value={settled}>
			<MotionConfig reducedMotion={reducedMotion} transition={spring.snappy}>
				{children}
			</MotionConfig>
		</AppSettled.Provider>
	);
}

/**
 * Whether a component should play its entrance, decided once at mount: yes when it was inserted after the app's first
 * render, or when the caller opts in. Content that arrives with the first render stays at rest.
 */
function useEntrance(animateOnMount: boolean): boolean {
	const settled = useContext(AppSettled);
	const [play] = useState(animateOnMount || settled);
	return play;
}

/** True when motion should skip movement (app setting, or the OS when the app follows it). */
export function useMotionReduced(): boolean {
	return useReducedMotionConfig() ?? false;
}

// ---------------- Expand ----------------

export interface ExpandProps {
	open: boolean;
	children: ReactNode;
	/** Classes for the inner content box. Padding belongs here so the collapsed height can reach 0. */
	className?: string;
	id?: string;
	/** Animate when the component first mounts already open. Default false: open-on-mount content renders at rest. */
	animateOnMount?: boolean;
}

/** Expand timing: open lets the height lead and the content follow 40ms later; close fades the content first. */
const expandOpen: Transition = { height: spring.snappy, opacity: { duration: duration.base, ease: ease.outQuart, delay: 0.04 } };
const expandClose: Transition = { height: { duration: 0.17, ease: [0.4, 0, 0.2, 1] }, opacity: { duration: 0.09, ease: "easeIn" } };
/**
 * Reduced motion still resolves the height to `auto`, at once: an Expand that was open when reduced motion turned on
 * can hold the pixel height its last animation left, and it would keep that height as its content changed.
 */
const reducedOpen: Transition = { ...fade, height: { duration: 0 } };
/**
 * Closing keyframes. `closed` starts from the pixel height the box had as it began to close (`custom`, see `Expand`):
 * from `auto`, motion would measure the end state by setting the height to 0 for a moment, and that clamps a scroller
 * near its end, so a transcript pinned to the bottom jumped by the whole height before the close animated.
 */
const expandVariants: Variants = {
	closed: (from: number | undefined) => ({ height: from === undefined ? 0 : [from, 0], opacity: 0, transition: expandClose }),
	closedReduced: { opacity: 0, transition: fadeOut },
};

/**
 * Animated height-auto disclosure for accordions, tool steps and "show more" rows. Content is unmounted while
 * closed. Overflow is clipped only while the height moves, so focus rings and shadows inside stay visible at rest.
 * Opening takes about 230ms with the content fading in just behind the height; closing takes about 170ms with the
 * content fading out first, so nothing pops. Reduced motion: an opacity crossfade with no height animation.
 *
 * A closing child keeps the props of its last open render (AnimatePresence), so state set as the close starts never
 * reaches it. The clip is therefore written on the element by the animation callbacks, which keeps the fading content
 * from spilling over the rows that move up beneath it, and the close's starting height goes through `custom`.
 */
export function Expand({ open, children, className, id, animateOnMount = false }: ExpandProps) {
	const reduced = useMotionReduced();
	const box = useRef<HTMLDivElement>(null);
	const clip = (moving: boolean) => {
		if (box.current) box.current.style.overflow = moving ? "hidden" : "";
	};
	// Read in the render that closes it, while the box still has its open height (later renders during the close are ignored).
	const from = open || reduced ? undefined : box.current?.offsetHeight;
	return (
		<AnimatePresence initial={animateOnMount} custom={from}>
			{open && (
				<motion.div
					ref={box}
					key="expand"
					id={id}
					variants={expandVariants}
					initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
					animate={reduced ? { height: "auto", opacity: 1, transition: reducedOpen } : { height: "auto", opacity: 1, transition: expandOpen }}
					exit={reduced ? "closedReduced" : "closed"}
					onAnimationStart={() => clip(true)}
					onAnimationComplete={() => clip(false)}
				>
					<div className={className}>{children}</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}

// ---------------- Stagger ----------------

type MotionDivProps = Omit<HTMLMotionProps<"div">, "initial" | "animate" | "exit" | "variants" | "transition">;

interface EntranceProps {
	/** Play the entrance even when this mounts with the app's first render. Default false (renders at rest). */
	animateOnMount?: boolean;
}

interface PlayOverride {
	/**
	 * Caller's decision, read at mount: `true` plays the entrance, `false` renders at rest. When set it overrides the
	 * automatic rule (useful when content remounts or arrives from history and only the caller knows it is new).
	 */
	play?: boolean;
}

export interface StaggerProps extends MotionDivProps, EntranceProps {
	/** Rendered element. */
	as?: "div" | "ul" | "ol" | "section";
	/** Seconds between items (20-30ms reads as a cascade without delaying the last item). */
	step?: number;
	/** Items after this index share the last delay, so long lists never wait. */
	max?: number;
	/** Seconds before the first item. */
	delay?: number;
}

/** `cascade`: the whole list is entering. `mounted`: set once the list has mounted, so later items know they are new. */
const StaggerContext = createContext<{ cascade: boolean; mounted: RefObject<boolean> } | null>(null);

/**
 * Parent for a list entrance. Children must be `StaggerItem`s (they may be nested in other elements).
 * A list inserted after the first render cascades in; a list present at first render shows at rest, and items added
 * to it later rise in one by one.
 */
export function Stagger({ as = "div", step = 0.025, max = 8, delay = 0, animateOnMount = false, children, ...rest }: StaggerProps) {
	const Tag = motion[as] as typeof motion.div;
	const cascade = useEntrance(animateOnMount);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
	}, []);
	const variants: Variants = {
		hidden: {},
		show: { transition: { delayChildren: (index: number) => delay + Math.min(index, max) * step } },
	};
	return (
		<StaggerContext.Provider value={{ cascade, mounted }}>
			<Tag initial={cascade ? "hidden" : false} animate="show" variants={variants} {...rest}>
				{children}
			</Tag>
		</StaggerContext.Provider>
	);
}

export interface StaggerItemProps extends MotionDivProps, PlayOverride {
	as?: "div" | "li" | "section" | "article";
	/** Rise distance in px. */
	distance?: number;
}

export function StaggerItem({ as = "div", distance = 6, play, children, ...rest }: StaggerItemProps) {
	const Tag = motion[as] as typeof motion.div;
	const list = useContext(StaggerContext);
	const settledEntrance = useEntrance(false);
	// Decided at mount: inside a cascading list, follow the list; otherwise rise only if this item arrived later.
	const [insertedLater] = useState(list ? list.mounted.current : settledEntrance);
	const variants: Variants = {
		hidden: { opacity: 0, y: distance },
		show: { opacity: 1, y: 0, transition: { y: spring.gentle, opacity: fade } },
	};
	const rise = { initial: "hidden", animate: "show" };
	const atRest = { initial: false as const };
	const entrance = play !== undefined ? (play ? rise : atRest) : list?.cascade ? {} : insertedLater ? rise : atRest;
	return (
		<Tag variants={variants} {...entrance} {...rest}>
			{children}
		</Tag>
	);
}

// ---------------- Rise / FadeIn ----------------

export interface RiseProps extends MotionDivProps, EntranceProps, PlayOverride {
	as?: "div" | "section" | "li" | "span" | "header" | "article";
	/** Seconds; applies only when the entrance plays. */
	delay?: number;
	/** Rise distance in px. */
	distance?: number;
	/** `gentle` (default) for surfaces and list entrances, `snappy` for chat rows that should settle quickly. */
	tempo?: "gentle" | "snappy";
}

/** Entrance for newly inserted content: fade in while rising a few pixels on a critically damped spring. At rest on first render. */
export function Rise({ as = "div", delay = 0, distance = 8, tempo = "gentle", animateOnMount = false, play: playProp, children, ...rest }: RiseProps) {
	const Tag = motion[as] as typeof motion.div;
	const auto = useEntrance(animateOnMount);
	const [play] = useState(playProp ?? auto);
	return (
		<Tag
			initial={play ? { opacity: 0, y: distance } : false}
			animate={{ opacity: 1, y: 0 }}
			transition={{ y: { ...spring[tempo], delay }, opacity: { ...fade, delay } }}
			{...rest}
		>
			{children}
		</Tag>
	);
}

export interface FadeInProps extends MotionDivProps, EntranceProps, PlayOverride {
	as?: "div" | "section" | "li" | "span";
	/** Seconds; applies only when the entrance plays. */
	delay?: number;
}

/** Opacity entrance for newly inserted content. At rest on first render. */
export function FadeIn({ as = "div", delay = 0, animateOnMount = false, play: playProp, children, ...rest }: FadeInProps) {
	const Tag = motion[as] as typeof motion.div;
	const auto = useEntrance(animateOnMount);
	const [play] = useState(playProp ?? auto);
	return (
		<Tag
			initial={play ? { opacity: 0 } : false}
			animate={{ opacity: 1 }}
			transition={{ ...fade, duration: duration.slow, delay }}
			{...rest}
		>
			{children}
		</Tag>
	);
}

// ---------------- PresenceSwap ----------------

export type SwapVariant = "fade" | "rise" | "slide";

const swapVariants: Record<SwapVariant, Variants> = {
	fade: {
		enter: { opacity: 0 },
		center: { opacity: 1, transition: fade },
		exit: { opacity: 0, transition: fadeOut },
	},
	rise: {
		enter: { opacity: 0, y: 8 },
		center: { opacity: 1, y: 0, transition: { y: spring.gentle, opacity: fade } },
		exit: { opacity: 0, y: -4, transition: fadeOut },
	},
	slide: {
		enter: (direction: number) => ({ opacity: 0, x: 24 * direction }),
		center: { opacity: 1, x: 0, transition: { x: spring.snappy, opacity: fade } },
		exit: (direction: number) => ({ opacity: 0, x: -16 * direction, transition: fadeOut }),
	},
};

export interface PresenceSwapProps {
	/** Changing this swaps the content (tab value, pane id, screen id). */
	swapKey: string | number;
	variant?: SwapVariant;
	/** Slide direction: 1 moves content in from the right, -1 from the left. */
	direction?: 1 | -1;
	/**
	 * `wait` (default) lets the old content leave before the new one enters. `popLayout` overlaps them; the parent
	 * then needs `position: relative`.
	 */
	mode?: "wait" | "popLayout" | "sync";
	/** Animate the first render too. Default false. */
	animateOnMount?: boolean;
	className?: string;
	children: ReactNode;
}

/** Crossfade, rise or slide between keyed children, for tab, pane and screen switches. */
export function PresenceSwap({
	swapKey,
	variant = "fade",
	direction = 1,
	mode = "wait",
	animateOnMount = false,
	className,
	children,
}: PresenceSwapProps) {
	return (
		<AnimatePresence mode={mode} initial={animateOnMount} custom={direction}>
			<motion.div
				key={swapKey}
				custom={direction}
				variants={swapVariants[variant]}
				initial="enter"
				animate="center"
				exit="exit"
				className={className}
			>
				{children}
			</motion.div>
		</AnimatePresence>
	);
}

// ---------------- Scroll follow ----------------

/** Share of the remaining distance one follow frame covers at 60fps (about 180ms to settle). */
const FOLLOW_LERP = 0.3;
/** Most one follow frame moves at 60fps, in px. */
const FOLLOW_MAX_STEP = 24;
/** A gap wider than this (a chat opening, a history load) is jumped, not chased. */
const FOLLOW_SNAP_PX = 480;
const FRAME_MS = 1000 / 60;

export interface ScrollFollowOptions {
	/** The scroller's content: its growth (streamed text, an opening card) is followed while pinned. */
	content?: RefObject<Element | null>;
	/** How close to the bottom still counts as pinned there, in px. */
	threshold?: number;
	/** The view is hidden: follow without easing, since nobody sees it. */
	paused?: boolean;
}

export interface ScrollFollow {
	/** Follow new content on the next frame, if the view is pinned to the bottom. */
	follow(): void;
	/** Go to the bottom now (a chat that just loaded). */
	snap(): void;
	/** The explicit "jump to latest" action: pin, then scroll smoothly to the bottom (instantly under reduced motion). */
	jumpToEnd(): void;
	/** Call first in the scroller's scroll handler; it settles `pinnedRef` from what moved the view. */
	onScroll(): void;
	/**
	 * The caller changed content above the view, and that change moved the view by `delta` px (the browser's scroll
	 * anchoring, or the caller putting a row back in place). The follow counts the move as layout, so a reader's scroll
	 * around it keeps its direction: a move up the reader made before the next scroll event still unpins.
	 */
	shift(delta: number): void;
}

/**
 * Keeps a scroller pinned to its bottom while content grows (DESIGN §1.12). One rAF loop reads the geometry once and
 * writes `scrollTop` once per frame, easing toward the bottom (30% of the gap per frame, at most 24px) and snapping
 * when the gap is large or motion is reduced. A move up away from the bottom (the reader's wheel, keys, scrollbar or
 * touch) unpins at once; the follow's own writes, layout moves the caller reports (`shift`) and moves down never unpin
 * (`ScrollLedger` and `pinnedAfterScroll` in scrollFollow.ts). Nothing follows until the reader returns within
 * `threshold` of the bottom or jumps there.
 */
export function useScrollFollow(
	ref: RefObject<HTMLElement | null>,
	pinnedRef: { current: boolean },
	{ content, threshold = 48, paused = false }: ScrollFollowOptions = {},
): ScrollFollow {
	const reduced = useMotionReduced();
	const instant = useRef(false);
	instant.current = reduced || paused;
	const [api] = useState(() => {
		let frame = 0;
		let lastFrame = 0;
		/** Where the follow left the view, to tell its own writes and layout from the reader's scrolling. */
		const ledger = new ScrollLedger();
		/** A smooth "jump to latest" is under way; the loop stays out of its way. */
		let jumping = false;
		const stop = () => {
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
			lastFrame = 0;
		};
		const write = (el: HTMLElement, top: number) => {
			el.scrollTop = top;
			ledger.wrote(el.scrollTop);
		};
		const run = (now: number) => {
			frame = 0;
			const el = ref.current;
			if (!el || !pinnedRef.current || jumping) return stop();
			const top = el.scrollTop;
			const target = el.scrollHeight - el.clientHeight;
			const gap = target - top;
			if (gap <= 0.5) return stop();
			if (instant.current || gap > FOLLOW_SNAP_PX) write(el, target);
			else {
				const frames = lastFrame ? Math.min(4, (now - lastFrame) / FRAME_MS) : 1;
				const step = Math.min(gap * (1 - (1 - FOLLOW_LERP) ** frames), FOLLOW_MAX_STEP * frames);
				write(el, Math.min(target, top + Math.max(1, step)));
			}
			lastFrame = now;
			frame = requestAnimationFrame(run);
		};
		const follow = () => {
			if (!frame && pinnedRef.current && !jumping) frame = requestAnimationFrame(run);
		};
		const unpin = () => {
			pinnedRef.current = false;
			jumping = false;
			stop();
		};
		return {
			follow,
			snap() {
				const el = ref.current;
				if (!el || !pinnedRef.current) return;
				stop();
				write(el, el.scrollHeight - el.clientHeight);
			},
			jumpToEnd() {
				const el = ref.current;
				if (!el) return;
				pinnedRef.current = true;
				stop();
				if (instant.current || el.scrollHeight - el.clientHeight - el.scrollTop <= 1) {
					write(el, el.scrollHeight - el.clientHeight);
					return;
				}
				jumping = true;
				el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
			},
			shift(delta: number) {
				ledger.shift(delta);
			},
			onScroll() {
				const el = ref.current;
				if (!el) return;
				const top = el.scrollTop;
				const distance = el.scrollHeight - top - el.clientHeight;
				const move = ledger.read(top, distance);
				if (move === "known") return;
				if (jumping) {
					if (move !== "up") return;
					jumping = false;
				}
				pinnedRef.current = pinnedAfterScroll(move, pinnedRef.current, distance, threshold);
				if (pinnedRef.current) follow();
				else stop();
			},
			/** Wheel up states intent before any scroll event; unpin immediately so no frame pulls the view back. */
			wheel(event: WheelEvent) {
				if (event.deltaY < 0) unpin();
			},
			scrollEnd() {
				if (!jumping) return;
				jumping = false;
				follow();
			},
			stop,
		};
	});

	useEffect(() => {
		const el = ref.current;
		const grown = content?.current;
		if (!el) return;
		el.addEventListener("wheel", api.wheel, { passive: true });
		el.addEventListener("scrollend", api.scrollEnd);
		// Content growth, and the scroller itself shrinking (a taller composer, a window resize), both open a gap below.
		const observer = new ResizeObserver(() => api.follow());
		observer.observe(el);
		if (grown) observer.observe(grown);
		return () => {
			el.removeEventListener("wheel", api.wheel);
			el.removeEventListener("scrollend", api.scrollEnd);
			observer.disconnect();
			api.stop();
		};
	}, [api, ref, content]);

	// Coming back into view (or into full motion) settles at the bottom at once.
	useEffect(() => {
		if (!paused) api.snap();
	}, [api, paused]);

	return api;
}

// ---------------- Block-in ----------------

const BLOCK_IN_MS = 160;

/**
 * One-shot entrance for a block appended to streaming content: opacity 0→1 while rising 2px over 160ms (opacity
 * only, 140ms, under reduced motion). `elapsedMs` continues an entrance begun on nodes this element replaces, so a
 * block whose HTML is re-rendered while it grows keeps one continuous fade. Returns false once the entrance would
 * already be over, so callers stop carrying it.
 */
export function blockIn(element: Element, reduced: boolean, elapsedMs = 0): boolean {
	const total = reduced ? 140 : BLOCK_IN_MS;
	if (elapsedMs >= total || typeof element.animate !== "function") return false;
	const frames: Keyframe[] = reduced
		? [{ opacity: 0 }, { opacity: 1 }]
		: [
				{ opacity: 0, transform: "translateY(2px)" },
				{ opacity: 1, transform: "none" },
			];
	const animation = element.animate(frames, { duration: total, easing: "cubic-bezier(0.25, 1, 0.5, 1)", fill: "backwards" });
	animation.currentTime = elapsedMs;
	return true;
}
