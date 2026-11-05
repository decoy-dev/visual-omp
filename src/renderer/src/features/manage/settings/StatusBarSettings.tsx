import { DEFAULT_STATUS_BAR } from "@shared/statusBar";
import { ArrowDown, ArrowUp, DotsSixVertical } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useDeferredTranslation } from "../../../i18n";
import { statusItems, type StatusItemSpec } from "../../../registry/slots";
import { orderedStatusItems, statusItemLocked } from "../../../shell/statusbar/layout";
import { moveStatusItem, showStatusItem } from "../../../shell/statusbar/customize";
import { useApp } from "../../../state/app";
import { Checkbox, cn, IconButton } from "../../../ui";
import { SettingsSection } from "./parts";

export function StatusBarSettings() {
	const { t } = useDeferredTranslation("settings");
	const preference = useApp(state => state.prefs?.statusBar) ?? DEFAULT_STATUS_BAR;
	const items = orderedStatusItems(statusItems.use(), preference);
	const [drag, setDrag] = useState<string | null>(null);
	const [drop, setDrop] = useState<{ side: string; index: number } | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const handles = useRef(new Map<string, HTMLButtonElement>());
	const move = async (item: StatusItemSpec, to: number) => {
		const next = moveStatusItem(items, preference, item.id, to);
		if (next === preference) return;
		await useApp.getState().setPrefs({ statusBar: next });
		const group = orderedStatusItems(items, next).filter(candidate => candidate.side === item.side);
		setAnnouncement(t("status.moved", { name: t(item.title), position: group.findIndex(candidate => candidate.id === item.id) + 1, count: group.length }));
		handles.current.get(item.id)?.focus({ preventScroll: true });
	};
	return <SettingsSection title={t("status.customize")} description={t("status.layoutHelp")}>
		{(["left", "right"] as const).map(side => {
			const group = items.filter(item => item.side === side);
			return <div key={side} className="py-3">
				<h3 className="mb-2 text-sm font-medium text-fg-muted">{t(`status.side.${side}`)}</h3>
				<ol aria-label={t(`status.side.${side}`)} className="flex flex-col gap-0.5">
					{group.map((item, index) => <li key={item.id} draggable onDragStart={event => {
						setDrag(item.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-vomp-status-item", item.id);
					}} onDragEnd={() => { setDrag(null); setDrop(null); }} onDragOver={event => {
						if (!drag || !group.some(item => item.id === drag)) return;
						event.preventDefault(); event.dataTransfer.dropEffect = "move";
						const box = event.currentTarget.getBoundingClientRect();
						setDrop({ side, index: event.clientY > box.top + box.height / 2 ? index + 1 : index });
					}} onDrop={event => {
						if (!drag || drop?.side !== side) return;
						const from = group.findIndex(item => item.id === drag);
						if (from < 0) return;
						event.preventDefault();
						void move(group[from]!, from < drop.index ? drop.index - 1 : drop.index);
						setDrag(null); setDrop(null);
					}} className={cn("relative flex min-h-9 items-center gap-toolbar rounded-sm px-row hover:bg-hover", drag === item.id && "opacity-45", drag && drop?.side === side && drop.index === index && "before:absolute before:inset-x-row before:-top-px before:h-0.5 before:bg-accent", drag && drop?.side === side && drop.index === group.length && index === group.length - 1 && "after:absolute after:inset-x-row after:-bottom-px after:h-0.5 after:bg-accent")}>
						<button ref={element => { if (element) handles.current.set(item.id, element); else handles.current.delete(item.id); }} type="button" className="flex size-7 shrink-0 cursor-grab items-center justify-center rounded-sm text-fg-faint hover:text-fg active:cursor-grabbing" aria-label={t("status.reorder", { name: t(item.title), position: index + 1, count: group.length })} title={t("status.reorderHelp")} onKeyDown={event => {
							if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
							event.preventDefault(); void move(item, index + (event.key === "ArrowUp" ? -1 : 1));
						}}><DotsSixVertical aria-hidden className="size-4" /></button>
						<Checkbox label={t(item.title)} checked={statusItemLocked(item) || !preference.hidden.includes(item.id)} disabled={statusItemLocked(item)} className="flex-1" onCheckedChange={show => void useApp.getState().setPrefs({ statusBar: showStatusItem(preference, item, show) })} />
						{statusItemLocked(item) && <span className="text-xs text-fg-muted">{t("status.required")}</span>}
						<IconButton size="sm" label={t("status.moveUp", { name: t(item.title) })} icon={<ArrowUp />} disabled={index === 0} onClick={() => void move(item, index - 1)} />
						<IconButton size="sm" label={t("status.moveDown", { name: t(item.title) })} icon={<ArrowDown />} disabled={index === group.length - 1} onClick={() => void move(item, index + 1)} />
					</li>)}
				</ol>
			</div>;
		})}
		<p aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>
	</SettingsSection>;
}
