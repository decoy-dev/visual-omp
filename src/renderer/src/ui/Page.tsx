/**
 * Full-page screens in the main area (DESIGN §5.6): Settings, Usage & limits, Help and the project
 * screens. A page replaces the chat instead of covering it; "Back" (or Esc, routed by the app's
 * shortcut handler) returns to where the user came from. One vertical scroll region per page; an
 * optional category rail sits on the left.
 */
import { CaretLeft } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";

export type PageWidth = "form" | "list" | "data";

/** Content column per kind of page: settings forms, management lists, reports. */
const widths: Record<PageWidth, string> = {
	form: "max-w-[680px]",
	list: "max-w-[920px]",
	data: "max-w-[1080px]",
};

export interface PageBack {
	/** "Back to chat", "Back to project". */
	label: string;
	onBack(): void;
}

export interface BackLinkProps extends PageBack {
	className?: string;
}

export function BackLink({ label, onBack, className }: BackLinkProps) {
	return (
		<button
			type="button"
			onClick={onBack}
			className={cn(
				"inline-flex h-7 items-center gap-1 rounded-md pl-1 pr-2 text-md font-medium text-accent transition-colors duration-(--dur-fast) hover:bg-hover",
				focusRing,
				className,
			)}
		>
			<CaretLeft className="size-4" aria-hidden />
			{label}
		</button>
	);
}

export interface PageFrameProps {
	back: PageBack;
	/** Category navigation (`NavRail`), shown in a left column under the back link. */
	nav?: ReactNode;
	width?: PageWidth;
	/** Identifies the page region for assistive technology, usually the page title. */
	label: string;
	/**
	 * Identity of what the page shows (page open sequence, Settings section). When it changes, the page
	 * title takes focus so a screen reader announces the new content.
	 */
	focusKey: string | number;
	children: ReactNode;
}

/** The page layout: back link and optional rail on the left, one scrolling content column. */
export function PageFrame({ back, nav, width = "form", label, focusKey, children }: PageFrameProps) {
	const content = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const scroller = content.current;
		if (!scroller) return;
		scroller.scrollTop = 0;
		scroller.querySelector<HTMLElement>("[data-page-title]")?.focus({ preventScroll: true });
	}, [focusKey]);
	return (
		<section aria-label={label} className="@container/page flex min-h-0 min-w-0 flex-1 bg-bg">
			{nav && (
				<div className="hidden w-[220px] shrink-0 flex-col border-r border-border bg-panel @2xl/page:flex">
					<div className="shrink-0 px-3 pb-2 pt-3">
						<BackLink {...back} />
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">{nav}</div>
				</div>
			)}
			<div ref={content} className="@container/content min-h-0 min-w-0 flex-1 overflow-y-auto">
				<div className={cn("mx-auto w-full px-6 pb-16 pt-5", widths[width])}>
					<div className={cn("mb-4 flex flex-col gap-3", nav ? "@2xl/page:hidden" : undefined)}>
						<BackLink {...back} className="self-start" />
						{/* Narrow pages show the rail's compact form (a select) here instead of the left column. */}
						{nav && <div className="@2xl/page:hidden">{nav}</div>}
					</div>
					{children}
				</div>
			</div>
		</section>
	);
}

export interface PageHeaderProps {
	title: ReactNode;
	/** One plain-language sentence under the title; wraps instead of truncating. */
	description?: ReactNode;
	/** Line under the description: scope ("All projects"), freshness ("Checked 2m ago"), paths. */
	meta?: ReactNode;
	/** Actions; beside the title when the content column has room, else under the text. */
	actions?: ReactNode;
	className?: string;
}

/** Page title (`--text-page`), description, meta line and actions. `PageFrame` focuses the title on open. */
export function PageHeader({ title, description, meta, actions, className }: PageHeaderProps) {
	return (
		<header className={cn("mb-8 flex flex-col gap-4 @2xl/content:flex-row @2xl/content:items-start", className)}>
			<div className="min-w-0 flex-1">
				<h1 data-page-title tabIndex={-1} className={cn("text-page font-bold tracking-[-0.02em] text-fg [overflow-wrap:anywhere]", focusRing)}>
					{title}
				</h1>
				{description && <p className="mt-1.5 text-md text-fg-muted">{description}</p>}
				{meta && <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-muted">{meta}</div>}
			</div>
			{actions && <div className="flex min-w-0 flex-wrap items-center gap-2 @2xl/content:max-w-[50%] @2xl/content:justify-end">{actions}</div>}
		</header>
	);
}
