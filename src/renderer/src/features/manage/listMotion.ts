import type { HTMLMotionProps } from "motion/react";
import { duration, ease, spring } from "@/ui";

/**
 * Props for a row in an animated list: spread onto a `motion.li` (or div) inside
 * `<AnimatePresence initial={false} mode="popLayout">`, with `position: relative` on the list. Rows present when the
 * list mounts render at rest; rows added later fade in and drop 4px into place, removed rows fade out, and the rest
 * slide to their new positions. Reduced motion keeps only the fades (MotionProvider).
 */
export const listRowMotion = {
	layout: "position",
	initial: { opacity: 0, y: -4 },
	animate: { opacity: 1, y: 0 },
	exit: { opacity: 0, transition: { duration: duration.fast, ease: "easeIn" } },
	transition: { layout: spring.gentle, y: spring.gentle, opacity: { duration: duration.base, ease: ease.outQuart } },
} satisfies HTMLMotionProps<"li">;
