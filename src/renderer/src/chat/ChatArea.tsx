import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ResizeHandle } from "../shell/ResizeHandle";
import { controllerFor, useApp } from "../state/app";
import { duration, ease, spring } from "../ui";
import { ChatView } from "./ChatView";

/** One chat, or two side by side (DESIGN §3.3 split view). The second chat slides in from the right and fades out. */
export function ChatArea(): ReactNode {
	const { t } = useTranslation("shell");
	const tabs = useApp(state => state.tabs);
	const activeTabId = useApp(state => state.activeTabId);
	const splitTabId = useApp(state => state.splitTabId);
	const focusedSplit = useApp(state => state.focusedSplit);
	const [leftWidth, setLeftWidth] = useState<number | null>(null);
	const primary = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];
	const secondary = splitTabId && splitTabId !== primary?.id ? tabs.find(tab => tab.id === splitTabId) : undefined;
	const primaryController = controllerFor(primary?.id);
	const secondaryController = controllerFor(secondary?.id);
	if (!primary || !primaryController) return null;

	return (
		<div className="relative flex min-w-0 flex-1">
			<div className="flex min-w-0 flex-col" style={secondary ? { width: leftWidth ?? "50%" } : { flex: 1 }}>
				<ChatView key={primary.id} session={primaryController} title={primary.title} focused={!secondary || focusedSplit === "primary"} />
			</div>
			{/* popLayout takes a leaving pane out of flow at once, so the first chat widens while the second fades. */}
			<AnimatePresence initial={false} mode="popLayout">
				{secondary && secondaryController && (
					<motion.div
						key="split"
						initial={{ opacity: 0, x: 24 }}
						animate={{ opacity: 1, x: 0, transition: { x: spring.gentle, opacity: { duration: duration.base, ease: ease.outQuart } } }}
						exit={{ opacity: 0, transition: { duration: duration.fast, ease: "easeIn" } }}
						className="flex min-w-0 flex-1"
					>
						<ResizeHandle
							label={t("resizeSplit")}
							value={leftWidth ?? window.innerWidth / 3}
							min={360}
							max={Math.max(420, window.innerWidth - 700)}
							direction={1}
							onChange={setLeftWidth}
						/>
						<div className="flex min-w-0 flex-1 flex-col border-l border-border">
							<ChatView key={secondary.id} session={secondaryController} title={secondary.title} focused={focusedSplit === "secondary"} />
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
