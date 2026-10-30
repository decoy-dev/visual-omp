import type { TspNode, TspPickerItem, TspText, TspTreeNode } from "@shared/tsp";
import { selectionCommits, TSP_ACTIONS } from "@shared/tsp/roles";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../ui/Button";
import { Input } from "../../../ui/Input";
import { plain } from "../labels";
import { rawKey } from "../keys";
import type { NodeProps } from "../nodes/context";
import { useTranslation } from "react-i18next";

interface ChoiceRow { id: string; label: TspText; detail?: TspText; disabled?: string | boolean; depth?: number; child?: TspNode; title?: string }
function treeRows(nodes: readonly TspTreeNode[], depth = 0): ChoiceRow[] {
	return nodes.flatMap(node => [{ id: node.id, label: node.label, depth }, ...(node.open === false ? [] : treeRows(node.children ?? [], depth + 1))]);
}
export function Choice({ node, context }: NodeProps) {
	const { t } = useTranslation("palette");
	const p = node.p;
	const picker = node.k === "picker" ? node.p : undefined;
	const list = node.k === "list" ? node.p : undefined;
	const tree = node.k === "tree" ? node.p : undefined;
	const rows: ChoiceRow[] = picker ? (picker.order ?? picker.items?.map(item => item.id) ?? []).flatMap(entry => {
		if (typeof entry !== "string") return [{ id: `group:${entry.group}`, label: entry.label, disabled: true }];
		const item = picker.items?.find(item => item.id === entry);
		return item ? [item as TspPickerItem] : [];
	}) : tree ? treeRows(tree.nodes ?? []) : (node.c ?? []).map(child => ({ id: child.p?.key ?? child.id, label: child.k === "item" ? child.p?.label ?? "" : "", detail: child.k === "item" ? child.p?.detail : undefined, disabled: child.k === "item" && child.p?.disabled, child }));
	const selectedFromOmp = picker?.selected ?? list?.selected ?? null;
	const [selected, setSelected] = useState<string | null>(selectedFromOmp);
	useEffect(() => setSelected(selectedFromOmp), [selectedFromOmp]);
	const localFirst = selectionCommits(p?.role ?? context.role, picker?.layout) || node.k === "tree";
	const prefix = useId();
	const listRef = useRef<HTMLDivElement>(null);
	const event = (ev: "select" | "activate", item: string) => { if (!context.readOnly) context.send({ ev, sf: context.sf, id: node.id, item }); };
	const choose = (row: ChoiceRow, activate = false) => {
		if (row.disabled || context.readOnly) return;
		setSelected(row.id);
		if (activate) { event("activate", row.id); return; }
		const actions = row.child?.p?.actions ?? (Array.isArray(p?.actions) ? undefined : p?.actions);
		const action = actions?.click;
		if (localFirst) return;
		if (action === "select" || picker) event("select", row.id);
		else if (action === "activate") event("activate", row.id);
		else if (action) context.send({ ev: "action", sf: context.sf, id: node.id, act: action, value: row.id });
	};
	const doubleClick = (row: ChoiceRow) => {
		if (row.disabled || context.readOnly) return;
		const actions = row.child?.p?.actions ?? (Array.isArray(p?.actions) ? undefined : p?.actions);
		const act = actions?.dblclick;
		if (!act || act === "activate" || localFirst) choose(row, true);
		else if (act === "select") event("select", row.id);
		else context.send({ ev: "action", sf: context.sf, id: node.id, act, value: row.id });
	};
	const selectedRow = rows.find(row => row.id === selected && !row.disabled);
	const action = (act: string, value?: string) => { if (!context.readOnly) context.send({ ev: "action", sf: context.sf, id: node.id, act, ...(value === undefined ? {} : { value }) }); };
	return <div className="space-y-stack">
		{picker?.title && <h3 className="text-lg font-semibold">{picker.title}</h3>}
		{picker?.subtitle && <p className="text-fg-muted">{plain(picker.subtitle)}</p>}
		{picker && picker.query !== null && picker.query !== undefined && <Input aria-label={picker.placeholder ?? t("tsp.search")} placeholder={picker.placeholder} value={picker.query} readOnly={context.readOnly} onChange={() => {}} onKeyDown={e => { if (e.key === "Tab") return; const key = rawKey(e); if (key && !context.readOnly) { e.preventDefault(); context.keys(key); } }} onPaste={e => { if (!context.readOnly) { e.preventDefault(); context.keys(e.clipboardData.getData("text")); } }} />}
		{picker?.scopes && <div className="flex gap-2 overflow-x-auto pb-2 [&>button]:shrink-0">{picker.scopes.map(scope => <Button key={scope.id} size="sm" variant={picker.scope === scope.id ? "primary" : "secondary"} disabled={!!scope.disabled || context.readOnly} onClick={() => action(TSP_ACTIONS.scope, scope.id)}>{plain(scope.label)}</Button>)}</div>}
		{picker?.tabs && <div role="tablist" aria-label={picker.title ?? t("tsp.choices")} className="flex flex-wrap gap-2">{picker.tabs.map(tab => <button type="button" role="tab" aria-selected={tab.id === picker.tab} key={tab.id} className="tsp-tab" disabled={context.readOnly} onClick={() => action(TSP_ACTIONS.tab, tab.id)}>{plain(tab.label)}</button>)}</div>}
		<div ref={listRef} role="listbox" aria-label={p?.aria ?? picker?.title ?? t("tsp.choices")} aria-activedescendant={selected ? `${prefix}-${selected}` : undefined} aria-disabled={context.readOnly} tabIndex={0} className="tsp-list" onKeyDown={e => {
			if (context.readOnly) return;
			if (e.key === "Enter" && selectedRow) { e.preventDefault(); choose(selectedRow, true); }
			if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
				e.preventDefault(); const enabled = rows.filter(row => !row.disabled); const index = enabled.findIndex(row => row.id === selected);
				const next = e.key === "Home" ? enabled[0] : e.key === "End" ? enabled.at(-1) : enabled[Math.max(0, Math.min(enabled.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
				if (next) { choose(next); document.getElementById(`${prefix}-${next.id}`)?.scrollIntoView?.({ block: "nearest" }); }
			}
		}}>
			{rows.map(row => <div id={`${prefix}-${row.id}`} role="option" aria-selected={selected === row.id} aria-disabled={!!row.disabled || context.readOnly} key={row.id} className="tsp-option" style={row.depth ? { paddingInlineStart: `${row.depth + 1}rem` } : undefined} title={row.title ?? plain(row.detail ?? row.label)} onClick={() => { listRef.current?.focus(); choose(row); }} onDoubleClick={() => doubleClick(row)}>
				<div className="min-w-0 flex-1"><div className="break-words font-medium">{row.child && row.child.k !== "item" ? context.render(row.child) : plain(row.label)}</div>{row.detail && <div className="break-words text-sm text-fg-muted">{plain(row.detail)}</div>}</div>
			</div>)}
			{rows.length === 0 && <p className="p-card text-fg-muted">{plain(picker?.empty ?? list?.empty) || t("tsp.empty")}</p>}
		</div>
		{picker?.message && <p role="status">{plain(picker.message)}</p>}
		{picker?.strip && <div className="flex flex-wrap items-center gap-2">{plain(picker.strip.label)}{picker.strip.items.map(item => <Button size="sm" key={item.id} variant={item.on ? "primary" : "secondary"} disabled={context.readOnly} onClick={() => action(TSP_ACTIONS.strip, item.id)}>{plain(item.label)}</Button>)}</div>}
		{picker?.confirm && <p>{plain(picker.confirm.text)}</p>}
		{picker?.actions && <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-border bg-overlay py-3">{picker.actions.map(button => <Button key={button.id} variant={button.primary ? "primary" : "secondary"} disabled={!!button.disabled || context.readOnly} title={typeof button.disabled === "string" ? button.disabled : undefined} onClick={() => {
			if (localFirst && selectedRow && (button.id === TSP_ACTIONS.switch || button.id === TSP_ACTIONS.confirm)) choose(selectedRow, true);
			else {
				if (localFirst && selectedRow && (button.id === TSP_ACTIONS.summarize || button.id === TSP_ACTIONS.label)) event("select", selectedRow.id);
				action(button.id);
			}
		}}>{button.label}</Button>)}</div>}
		{(!picker || !picker.actions?.length) && <Button variant="primary" disabled={!selectedRow || context.readOnly} onClick={() => selectedRow && choose(selectedRow, true)}>{t("tsp.confirm")}</Button>}
		{node.c && picker && <div className="space-y-stack">{node.c.map(child => context.render(child))}</div>}
	</div>;
}
