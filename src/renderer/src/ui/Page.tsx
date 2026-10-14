/**
 * Full-page screens in the main area (DESIGN §5.6): Settings, Usage & limits, Help and the project
 * screens. A page replaces the chat instead of covering it; "Back" (or Esc, routed by the app's
 * shortcut handler) returns to where the user came from. One vertical scroll region per page; an
 * optional category rail sits in the ink sidebar when it is shown, else on the left of the page.
 */
import { CaretLeft } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { cn } from "./cn";
import { Skeleton } from "./Display";
import { NavRailPlacementContext } from "./NavRail";
import { focusRing } from "./styles";

/** What a page put in the sidebar slot: its section nav (the chat lists stand aside), or only its back link. */
export type PageNavSlotMode = "nav" | "back";

export interface PageNavSlotState {
	/** The sidebar's slot element; null while the sidebar is hidden. */
	slot: HTMLElement | null;
	/** Ref callback for the sidebar's slot element. Keep the element mounted, also while claimed. */
	setSlot(slot: HTMLElement | null): void;
	/** null: no page in the slot. `nav`: hide the chat lists, the slot takes the space. `back`: keep the lists under the back row. */
	mode: PageNavSlotMode | null;
}

/**
 * Page nav slot: the sidebar renders `<div ref={setSlot} />` above its chat lists. Every `PageFrame` portals its back
 * link into the slot while one exists, so Back has one place app-wide; a page with a section `nav` (Settings) brings
 * its rail too and the sidebar hides its lists, so the page never shows three columns and only one nav tree exists at
 * a time. Without a slot (sidebar hidden) the page renders both inline.
 */
export const usePageNavSlot = create<PageNavSlotState>((set, get) => ({
	slot: null,
	setSlot: slot => {
		if (get().slot !== slot) set({ slot });
	},
	mode: null,
}));

/** The page holding the slot. A claim is released only by its owner, so an exiting page cannot clear its successor's. */
let slotOwner: object | null = null;

function claimNavSlot(owner: object, mode: PageNavSlotMode): void {
	slotOwner = owner;
	usePageNavSlot.setState({ mode });
}

function releaseNavSlot(owner: object): void {
	if (slotOwner !== owner) return;
	slotOwner = null;
	usePageNavSlot.setState({ mode: null });
}

export type PageWidth = "form" | "list" | "data";

/** `canvas` (default): the gray page canvas; bare sections sit on it, grouped data goes in white cards. `sheet`: the white sheet, for chat-like pages. */
export type PageTone = "canvas" | "sheet";

/** Content column per kind of page: settings forms, management lists, reports. */
const widths: Record<PageWidth, string> = {
	form: "max-w-170",
	list: "max-w-230",
	data: "max-w-270",
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
	/** Category navigation (`NavRail`): in the sidebar under the back link when shown, else a left column. */
	nav?: ReactNode;
	width?: PageWidth;
	/** Surface under the content; defaults to the canvas. */
	tone?: PageTone;
	/** Identifies the page region for assistive technology, usually the page title. */
	label: string;
	/**
	 * Identity of what the page shows (page open sequence, Settings section). When it changes, the page
	 * title takes focus so a screen reader announces the new content.
	 */
	focusKey: string | number;
	/** Return to where the reader left the page on an earlier visit instead of the top. */
	scrollMemory?: PageScrollMemory;
	children: ReactNode;
}

export interface PageScrollMemory {
	/** Saved distance from the top, in px. */
	top: number;
	/** The content that sets the page's height has rendered; `top` is applied once, at that point. */
	ready: boolean;
	/** Receives the position as the page scrolls. */
	save(top: number): void;
}

/** The back row, in the sidebar slot or in the page's left column. */
function BackRow({ back }: { back: PageBack }) {
	return (
		<div data-page-back className="shrink-0 px-3 pb-2 pt-3">
			<BackLink {...back} />
		</div>
	);
}

/** Back link over the rail, in the sidebar slot or in the page's left column. */
function RailColumn({ back, nav }: { back: PageBack; nav: ReactNode }) {
	return (
		<>
			<BackRow back={back} />
			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">{nav}</div>
		</>
	);
}

/** The page layout: back link and optional rail (sidebar slot or left column), one scrolling content column. */
export function PageFrame({ back, nav, width = "form", tone = "canvas", label, focusKey, scrollMemory, children }: PageFrameProps) {
	const docked = usePageNavSlot(state => state.slot);
	const mode: PageNavSlotMode = nav ? "nav" : "back";
	useLayoutEffect(() => {
		if (!docked) return;
		const owner = {};
		claimNavSlot(owner, mode);
		return () => releaseNavSlot(owner);
	}, [docked, mode]);
	const content = useRef<HTMLDivElement>(null);
	const memory = useRef(scrollMemory);
	memory.current = scrollMemory;
	const restorePending = useRef(false);
	useEffect(() => {
		const scroller = content.current;
		if (!scroller) return;
		scroller.scrollTop = 0;
		restorePending.current = (memory.current?.top ?? 0) > 0;
		const title = () => scroller.querySelector<HTMLElement>("[data-page-title]");
		const now = title();
		if (now) {
			now.focus({ preventScroll: true });
			return;
		}
		// A page or section loading from its own chunk renders its title a moment later; it takes focus
		// then, unless the reader has moved focus in the meantime.
		const before = document.activeElement;
		const observer = new MutationObserver(() => {
			const late = title();
			if (!late && document.activeElement === before) return;
			observer.disconnect();
			if (late && document.activeElement === before) late.focus({ preventScroll: true });
		});
		observer.observe(scroller, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [focusKey]);
	const ready = scrollMemory?.ready ?? false;
	useEffect(() => {
		const scroller = content.current;
		if (!scroller || !ready || !restorePending.current) return;
		restorePending.current = false;
		scroller.scrollTop = memory.current?.top ?? 0;
	}, [focusKey, ready]);
	const inlineNav = docked ? null : nav;
	return (
		<section aria-label={label} data-surface={tone} className="@container/page flex min-h-0 min-w-0 flex-1 bg-bg">
			{docked &&
				createPortal(
					nav ? (
						<NavRailPlacementContext.Provider value="sidebar">
							<div className="flex min-h-0 flex-1 flex-col">
								<RailColumn back={back} nav={nav} />
							</div>
						</NavRailPlacementContext.Provider>
					) : (
						<BackRow back={back} />
					),
					docked,
				)}
			{inlineNav && (
				<div className={cn("hidden w-55 shrink-0 flex-col @2xl/page:flex", tone === "sheet" && "border-r border-border")}>
					<RailColumn back={back} nav={inlineNav} />
				</div>
			)}
			<div
				ref={content}
				onScroll={scrollMemory ? event => memory.current?.save(event.currentTarget.scrollTop) : undefined}
				className="@container/content min-h-0 min-w-0 flex-1 overflow-y-auto"
			>
				<div className={cn("mx-auto w-full px-page pb-16 pt-page", widths[width])}>
					{/* The back link sits over the rail when there is one; narrow pages show the rail's compact form (a select) here. */}
					{!docked && (
						<div className={cn("mb-4 flex flex-col gap-3", inlineNav ? "@2xl/page:hidden" : undefined)}>
							<div data-page-back className="self-start">
								<BackLink {...back} />
							</div>
							{inlineNav && <div className="@2xl/page:hidden">{inlineNav}</div>}
						</div>
					)}
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
		<header className={cn("mb-section flex flex-col gap-4 @2xl/content:flex-row @2xl/content:items-start", className)}>
			<div className="min-w-0 flex-1">
				{/* `w-fit` keeps the keyboard focus ring around the words instead of the whole column. */}
				<h1 data-page-title tabIndex={-1} className={cn("w-fit max-w-full rounded-sm text-page font-bold tracking-[-0.02em] text-fg [overflow-wrap:anywhere]", focusRing)}>
					{title}
				</h1>
				{description && <p className="mt-2 text-md text-fg-muted">{description}</p>}
				{meta && <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-muted">{meta}</div>}
			</div>
			{actions && <div className="flex min-w-0 flex-wrap items-center gap-2 @2xl/content:max-w-[50%] @2xl/content:justify-end">{actions}</div>}
		</header>
	);
}

/** Stands in for a page's content (header, then cards) while it loads; `aria-busy` tells assistive technology. */
export function PageSkeleton() {
	return (
		<div aria-busy className="flex flex-col gap-4">
			<div className="mb-section flex flex-col gap-stack">
				<Skeleton className="h-7 w-48 max-w-full" />
				<Skeleton shape="text" className="w-80 max-w-full" />
			</div>
			<Skeleton className="h-24" />
			<Skeleton className="h-40" />
		</div>
	);
}
