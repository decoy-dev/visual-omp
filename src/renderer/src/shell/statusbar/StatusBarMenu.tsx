import { DEFAULT_STATUS_BAR } from "@shared/statusBar";
import { useEffect, useRef } from "react";
import { useDeferredTranslation } from "../../i18n";
import { statusItems } from "../../registry/slots";
import { useApp } from "../../state/app";
import { openSettings } from "../../state/navigation";
import { ContextMenu, ContextMenuTrigger, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "../../ui";
import { orderedStatusItems, statusItemLocked } from "./layout";
import { showStatusItem } from "./customize";

export function StatusBarMenu({ point, close }: { point: { x: number; y: number; origin: HTMLElement }; close(): void }) {
	const trigger = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		trigger.current?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: point.x, clientY: point.y }));
	}, [point]);
	return <ContextMenu onOpenChange={open => { if (!open) close(); }}>
		<ContextMenuTrigger ref={trigger} className="hidden" aria-hidden />
		<StatusBarChecklist returnFocus={() => point.origin.focus({ preventScroll: true })} />
	</ContextMenu>;
}

function StatusBarChecklist({ returnFocus }: { returnFocus(): void }) {
	const { t } = useDeferredTranslation("settings");
	const preference = useApp(state => state.prefs?.statusBar) ?? DEFAULT_STATUS_BAR;
	const items = orderedStatusItems(statusItems.use(), preference);
	return <ContextMenuContent className="max-h-[min(34rem,calc(100vh-2rem))] overflow-y-auto" onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
		<ContextMenuLabel>{t("status.customize")}</ContextMenuLabel>
		{items.map(item => <ContextMenuCheckboxItem key={item.id} checked={statusItemLocked(item) || !preference.hidden.includes(item.id)} disabled={statusItemLocked(item)} onSelect={event => event.preventDefault()} onCheckedChange={show => void useApp.getState().setPrefs({ statusBar: showStatusItem(preference, item, show) })}>
			{t(item.title)}
		</ContextMenuCheckboxItem>)}
		<ContextMenuSeparator />
		<ContextMenuItem onSelect={() => openSettings("appearance")}>{t("status.arrange")}</ContextMenuItem>
	</ContextMenuContent>;
}
