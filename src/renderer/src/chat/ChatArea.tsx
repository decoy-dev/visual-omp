import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ResizeHandle } from "../shell/ResizeHandle";
import { type ChatTab, controllerFor, useApp } from "../state/app";
import { cn, duration, ease, spring } from "../ui";
import { ChatView } from "./ChatView";

/** Narrowest a chat may get in split view; below twice this the chat area shows only the focused chat. */
const PANE_MIN = 360;

interface PaneProps {
	tab: ChatTab;
	which: "primary" | "secondary";
	/** Both halves of a split are showing. */
	split: boolean;
	focused: boolean;
	/** layoutId prefix, so the focus line slides between the two halves. */
	scope: string;
}

/**
 * One half of the chat area. In split view the focused half (the one keyboard commands act on) carries a 2px
 * accent line along its top edge that slides across when focus moves; clicking anywhere in a half focuses it.
 */
function Pane({ tab, which, split, focused, scope }: PaneProps): ReactNode {
	const { t } = useTranslation("shell");
	const controller = controllerFor(tab.id);
	if (!controller) return null;
	return (
		<div
			role={split ? "group" : undefined}
			aria-label={split ? t(which === "primary" ? "split.left" : "split.right") : undefined}
			aria-current={split && focused ? "true" : undefined}
			className="relative flex min-w-0 flex-1 flex-col"
			onPointerDownCapture={() => {
				if (split && !focused) useApp.getState().focusSplit(which);
			}}
		>
			<ChatView key={tab.id} session={controller} title={tab.title} focused={!split || focused} />
			{split && focused && (
				<motion.span aria-hidden layoutId={`${scope}-focus`} transition={spring.snappy} className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-accent" />
			)}
		</div>
	);
}

/**
 * One chat, or two side by side (DESIGN §3.3 split view). The second chat slides in from the right and fades out.
 * Split view fits itself to the chat area's own width: when the area is narrower than two minimum-width chats,
 * only the focused chat shows and its partner stays mounted, hidden and inert, so it comes back as it was. The
 * divider keeps each chat at least `PANE_MIN` wide and is pulled back in when the area shrinks.
 */
export function ChatArea(): ReactNode {
	const { t } = useTranslation("shell");
	const scope = useId();
	const tabs = useApp(state => state.tabs);
	const activeTabId = useApp(state => state.activeTabId);
	const splitTabId = useApp(state => state.splitTabId);
	const focusedSplit = useApp(state => state.focusedSplit);
	const root = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState<number | null>(null);
	const [leftWidth, setLeftWidth] = useState<number | null>(null);
	const primary = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];
	const secondary = splitTabId && splitTabId !== primary?.id ? tabs.find(tab => tab.id === splitTabId) : undefined;
	const hasPrimary = primary !== undefined && controllerFor(primary.id) !== null;
	const maxLeft = width === null ? null : width - PANE_MIN;

	useLayoutEffect(() => {
		const element = root.current;
		if (!element) return;
		setWidth(element.getBoundingClientRect().width);
		const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
		observer.observe(element);
		return () => observer.disconnect();
	}, [hasPrimary]);

	// Pull a divider the user placed back inside the area when the area shrinks.
	useEffect(() => {
		if (leftWidth !== null && maxLeft !== null && maxLeft >= PANE_MIN && leftWidth > maxLeft) setLeftWidth(maxLeft);
	}, [leftWidth, maxLeft]);

	if (!primary || !hasPrimary) return null;
	const split = secondary !== undefined && controllerFor(secondary.id) !== null;
	const fits = width === null || width >= PANE_MIN * 2;
	const both = split && fits;
	// Too narrow for two chats: the half without focus waits, hidden.
	const hidden = split && !fits ? (focusedSplit === "secondary" ? "primary" : "secondary") : null;
	const left = width === null || maxLeft === null ? null : Math.min(Math.max(leftWidth ?? width / 2, PANE_MIN), maxLeft);

	return (
		<div ref={root} className="relative flex min-w-0 flex-1">
			<div
				inert={hidden === "primary"}
				className={cn("flex min-w-0 flex-col", hidden === "primary" && "invisible absolute inset-0")}
				style={both ? { width: left ?? "50%" } : { flex: 1 }}
			>
				<Pane tab={primary} which="primary" split={both} focused={focusedSplit === "primary"} scope={scope} />
			</div>
			{/* popLayout takes a leaving pane out of flow at once, so the first chat widens while the second fades. */}
			<AnimatePresence initial={false} mode="popLayout">
				{split && secondary && (
					<motion.div
						key="split"
						inert={hidden === "secondary"}
						initial={{ opacity: 0, x: 24 }}
						animate={{ opacity: 1, x: 0, transition: { x: spring.gentle, opacity: { duration: duration.base, ease: ease.outQuart } } }}
						exit={{ opacity: 0, transition: { duration: duration.fast, ease: "easeIn" } }}
						className={cn("flex min-w-0 flex-1", hidden === "secondary" && "invisible absolute inset-0")}
					>
						{both && left !== null && maxLeft !== null && (
							<ResizeHandle label={t("resizeSplit")} value={left} min={PANE_MIN} max={maxLeft} direction={1} onChange={setLeftWidth} />
						)}
						<div className={cn("flex min-w-0 flex-1 flex-col", both && "border-l border-border")}>
							<Pane tab={secondary} which="secondary" split={both} focused={focusedSplit === "secondary"} scope={scope} />
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
