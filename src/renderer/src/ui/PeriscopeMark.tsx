import { motion, useAnimationControls } from "motion/react";
import { useEffect, useId, useRef } from "react";
import { MARK_VIEWBOX, MarkShapes } from "./BrandMark";
import { cn } from "./cn";
import { ease, spring, useMotionReduced } from "./motion";
import "./PeriscopeMark.css";

export type PeriscopeMood = "still" | "enter" | "celebrate";

export interface PeriscopeMarkProps {
	size: number;
	mood?: PeriscopeMood;
	/** Each change pulses the lens once, without restarting the mark's current mood. */
	flash?: number;
	inverse?: boolean;
	title?: string;
	className?: string;
}

/** Setup-only character animation. BrandMark remains the single source of the mark's shapes. */
export function PeriscopeMark({ size, mood = "still", flash, inverse = false, title, className }: PeriscopeMarkProps) {
	const reduced = useMotionReduced();
	const id = useId();
	const lensClip = `${id}-lens`;
	const entering = mood === "enter" && !reduced;
	const celebrating = mood === "celebrate" && !reduced;
	const ink = "var(--fg)";
	const lens = "var(--accent)";
	const { x, y, width, height } = MARK_VIEWBOX;
	const flashControls = useAnimationControls();
	const previousFlash = useRef(flash);

	useEffect(() => {
		if (reduced) {
			flashControls.stop();
			flashControls.set({ opacity: 1 });
		} else if (previousFlash.current !== flash) {
			void flashControls.start({ opacity: [1, 0.35, 1], transition: { duration: 0.14, ease: ease.outQuart } });
		}
		previousFlash.current = flash;
	}, [flash, reduced, flashControls]);

	return (
		<svg
			width={size}
			height={size}
			viewBox={`${x} ${y} ${width} ${height}`}
			fill="none"
			role={title ? "img" : undefined}
			aria-label={title}
			aria-hidden={title ? undefined : true}
			data-region={inverse ? "chrome" : undefined}
			className={cn("shrink-0 overflow-visible", className)}
		>
			<defs>
				<clipPath id={lensClip}><MarkShapes part="lens" ink={ink} lens={lens} /></clipPath>
			</defs>
			<g key={`${mood}-${reduced}`}>
				<motion.g
					initial={entering ? { opacity: 0, y: 28 } : false}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.35, ease: ease.outExpo }}
				>
					<MarkShapes part="chevron" ink={ink} lens={lens} />
					<MarkShapes part="base" ink={ink} lens={lens} />
				</motion.g>
				<motion.g
					initial={celebrating ? { y: 0 } : false}
					animate={celebrating ? { y: [0, -height * 0.1, 0] } : { y: 0 }}
					transition={{ duration: 0.66, times: [0, 0.4, 1], ease: ease.outQuart }}
				>
					<motion.g
						initial={entering ? { scaleY: 0, opacity: 0 } : false}
						animate={{ scaleY: 1, opacity: 1 }}
						style={{ transformBox: "view-box", originX: `${540 - x}px`, originY: `${748 - y}px` }}
						transition={{ ...spring.gentle, visualDuration: 0.5, delay: entering ? 0.22 : 0 }}
					>
						<g className={entering ? "periscope-mark-head" : undefined}>
							<MarkShapes part="periscope" ink={ink} lens={lens} />
							<motion.g
								initial={entering ? { opacity: 0, scale: 0.6 } : false}
								animate={{ opacity: entering ? [0, 1, 0.35, 1] : 1, scale: 1 }}
								style={{ transformBox: "view-box", originX: `${814 - x}px`, originY: `${304 - y}px` }}
								transition={{
									...spring.snappy,
									delay: entering ? 0.72 : 0,
									opacity: { duration: entering ? 0.36 : 0, delay: entering ? 0.72 : 0, times: [0, 0.55, 0.72, 1], ease: ease.outQuart },
								}}
							>
								<motion.g
									initial={false}
									animate={flashControls}
								>
									<MarkShapes part="lens" ink={ink} lens={lens} />
								</motion.g>
								{celebrating && (
									<g clipPath={`url(#${lensClip})`}>
										<motion.rect
											x="0" y="0" width="1024" height="72" fill="var(--accent-hover)"
											initial={{ y: 140, opacity: 0 }}
											animate={{ y: 390, opacity: [0, 0.8, 0] }}
											transition={{ duration: 0.42, delay: 0.2, ease: ease.outQuart }}
										/>
									</g>
								)}
							</motion.g>
						</g>
					</motion.g>
				</motion.g>
			</g>
		</svg>
	);
}
