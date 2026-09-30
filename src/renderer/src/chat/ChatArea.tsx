import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ResizeHandle } from "../shell/ResizeHandle";
import { controllerFor, useApp } from "../state/app";
import { ChatView } from "./ChatView";

/** One chat, or two side by side (DESIGN §3.3 split view). */
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
		<div className="flex min-w-0 flex-1">
			<div className="flex min-w-0 flex-col" style={secondary ? { width: leftWidth ?? "50%" } : { flex: 1 }}>
				<ChatView key={primary.id} session={primaryController} title={primary.title} focused={!secondary || focusedSplit === "primary"} />
			</div>
			{secondary && secondaryController && (
				<>
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
				</>
			)}
		</div>
	);
}
