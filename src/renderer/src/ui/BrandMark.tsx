/**
 * The brand mark: the only place its geometry lives in the app. The mark is periscope variation C1 "Heavy"
 * (docs/logo-concepts/2-periscope/variants/c-prompt/variations/c1-heavy): a heavy prompt chevron, and a periscope
 * rising from the prompt's underscore with a teal lens plate. The packaged app icons (assets/icon.svg,
 * assets/icon-macos.svg) and the README hero (assets/hero.svg) carry copies of the same shapes.
 */
import { cn } from "./cn";

/** Square crop around the shapes (x 186–838, y 216–808), matching the title-bar lockup in the concept files. */
const MARK_VIEWBOX = { x: 186, y: 186, width: 652, height: 652 };

/** C1 "Heavy" on its 1024 grid. `ink` paints the chevron, underscore and periscope; `lens` paints the lens plate. */
function MarkShapes({ ink, lens }: { ink: string; lens: string }) {
	return (
		<>
			<path d="M230 600L342 682L230 764" fill="none" stroke={ink} strokeWidth="88" strokeLinecap="round" strokeLinejoin="round" />
			<rect x="420" y="712" width="382" height="72" fill={ink} />
			<path d="M474 392L650 216H762V392H606V748H474Z" fill={ink} />
			<rect x="790" y="234" width="48" height="140" rx="10" fill={lens} />
		</>
	);
}

export interface BrandMarkProps {
	/** Rendered height in px; the mark is square. */
	size?: number;
	/** Accessible name; omit when decorative (next to visible text). */
	title?: string;
	/**
	 * `accent` (default): ink in `--fg` and the lens in `--accent`, so it follows the theme.
	 * `current`: every shape in the surrounding text color (the one-color mark).
	 */
	tone?: "accent" | "current";
	className?: string;
}

/** The brand mark. Exported from ui/ as both `BrandMark` and `Mark`. */
export function BrandMark({ size = 20, title, tone = "accent", className }: BrandMarkProps) {
	const { x, y, width, height } = MARK_VIEWBOX;
	const mono = tone === "current";
	return (
		<svg
			width={(size * width) / height}
			height={size}
			viewBox={`${x} ${y} ${width} ${height}`}
			fill="none"
			role={title ? "img" : undefined}
			aria-label={title}
			aria-hidden={title ? undefined : true}
			className={cn("shrink-0", className)}
		>
			<MarkShapes ink={mono ? "currentColor" : "var(--fg)"} lens={mono ? "currentColor" : "var(--accent)"} />
		</svg>
	);
}
