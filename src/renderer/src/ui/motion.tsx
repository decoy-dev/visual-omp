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

/**
 * Animated height-auto disclosure for accordions, tool steps and "show more" rows. Content is unmounted while
 * closed. Overflow is clipped only while the height moves, so focus rings and shadows inside stay visible at rest.
 * Reduced motion: an opacity crossfade with no height animation.
 */
export function Expand({ open, children, className, id, animateOnMount = false }: ExpandProps) {
	const reduced = useMotionReduced();
	const [moving, setMoving] = useState(false);
	const closed = reduced ? { opacity: 0 } : { height: 0, opacity: 0 };
	return (
		<AnimatePresence initial={animateOnMount}>
			{open && (
				<motion.div
					key="expand"
					id={id}
					initial={closed}
					animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1 }}
					exit={closed}
					transition={{ height: spring.gentle, opacity: fade }}
					onAnimationStart={() => setMoving(true)}
					onAnimationComplete={() => setMoving(false)}
					style={{ overflow: moving ? "hidden" : undefined }}
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
}

/** Entrance for newly inserted content: fade in while rising a few pixels on `spring.gentle`. At rest on first render. */
export function Rise({ as = "div", delay = 0, distance = 8, animateOnMount = false, play: playProp, children, ...rest }: RiseProps) {
	const Tag = motion[as] as typeof motion.div;
	const auto = useEntrance(animateOnMount);
	const [play] = useState(playProp ?? auto);
	return (
		<Tag
			initial={play ? { opacity: 0, y: distance } : false}
			animate={{ opacity: 1, y: 0 }}
			transition={{ y: { ...spring.gentle, delay }, opacity: { ...fade, delay } }}
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
