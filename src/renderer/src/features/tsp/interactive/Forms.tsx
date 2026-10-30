import type { TspPrefsRow } from "@shared/tsp";
import { TSP_ACTIONS } from "@shared/tsp/roles";
import { useTranslation } from "react-i18next";
import { Button } from "../../../ui/Button";
import { Input } from "../../../ui/Input";
import { Switch } from "../../../ui/Switch";
import { Select, SelectItem } from "../../../ui/Select";
import { plain } from "../labels";
import { rawKey } from "../keys";
import type { NodeContext, NodeProps } from "../nodes/context";

function PrefControl({ row, context, id }: { row: TspPrefsRow; context: NodeContext; id: string }) {
	const c = row.control;
	const disabled = context.readOnly || !!row.disabled;
	const change = (value: boolean | number | string | string[]) => { if (!disabled) context.send({ ev: "change", sf: context.sf, id, item: row.id, value }); };
	switch (c.k) {
		case "switch": return <Switch aria-label={row.label} checked={c.on} disabled={disabled} onCheckedChange={change} />;
		case "choice": return <Select aria-label={row.label} value={c.value} disabled={disabled} onValueChange={change} contentClassName="tsp-select-popup">{c.options.map(option => <SelectItem key={option.value} value={option.value} hint={option.detail}>{option.label}</SelectItem>)}</Select>;
		case "number": return <Input aria-label={row.label} type="number" value={c.value} min={c.min} max={c.max} step={c.step} disabled={disabled} onChange={e => { if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber)) change(e.target.valueAsNumber); }} />;
		case "text": return <Input aria-label={row.label} type={c.secret ? "password" : "text"} value={c.value} placeholder={c.placeholder} disabled={disabled} onChange={e => change(e.target.value)} />;
		case "multi": return <div className="flex flex-wrap gap-3">{c.options.map(option => <label key={option.value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={c.values.includes(option.value)} disabled={disabled} onChange={e => change(e.target.checked ? [...c.values, option.value] : c.values.filter(value => value !== option.value))} />{option.label}</label>)}</div>;
		case "keys": return <span className="font-mono text-sm">{c.keys.map(keys => keys.join("+")).join(", ")}</span>;
		case "action": return <Button variant="secondary" disabled={disabled} onClick={() => context.send({ ev: "action", sf: context.sf, id, act: c.act, value: row.id })}>{c.label}</Button>;
	}
}
export function Forms({ node, context }: NodeProps) {
	const { t } = useTranslation("palette");
	const action = (act: string, value?: string) => context.send({ ev: "action", sf: context.sf, id: node.id, act, ...(value === undefined ? {} : { value }) });
	if (node.k === "prefs") {
		const p = node.p;
		if (!p) return null;
		return <div className="space-y-section">
			<h3 className="text-lg font-semibold">{p.title}</h3>
			<div className="flex flex-wrap gap-2" role="tablist" aria-label={p.title}>{p.pages.map(page => <button type="button" key={page.id} role="tab" aria-selected={page.id === p.page} className="tsp-tab" disabled={context.readOnly || !!page.disabled} onClick={() => action(TSP_ACTIONS.page, page.id)}>{page.label}</button>)}</div>
			<Input aria-label={t("tsp.searchSettings")} placeholder={t("tsp.searchSettings")} value={p.query ?? ""} readOnly={context.readOnly} onChange={() => {}} onKeyDown={e => { if (e.key === "Tab") return; const key = rawKey(e); if (key && !context.readOnly) { e.preventDefault(); context.keys(key); } }} />
			{p.lead && <p className="text-fg-muted">{p.lead}</p>}
			{p.sections.map(section => <section key={section.id} className="space-y-stack"><h4 className="font-semibold">{section.title}</h4><div className="divide-y divide-border">{section.rows.map(row => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3" title={row.disabled}><div className="min-w-0 flex-1"><p className="font-medium">{row.label}</p>{row.hint && <p className="mt-1 text-sm text-fg-muted">{row.hint}</p>}{row.warning && <p className="mt-1 text-sm text-warn">{row.warning}</p>}</div><div className="min-w-0 max-w-full sm:max-w-80"><PrefControl row={row} context={context} id={node.id} /></div></div>)}</div></section>)}
			{node.c?.map(child => context.render(child))}
		</div>;
	}
	if (node.k === "effort") return <span className="inline-flex items-center gap-2 text-sm" aria-label={`${t("tsp.effort")}: ${node.p?.level ?? ""}`}>{t("tsp.effort")}: <span className="font-mono">{node.p?.level}</span></span>;
	if (node.k !== "editor" && node.k !== "input") return null;
	const p = node.p;
	const text = p?.text ?? "";
	const readonly = context.readOnly || p?.readonly;
	const props = { "aria-label": p?.aria ?? (plain(p?.prompt) || t("tsp.input")), value: text, readOnly: readonly, placeholder: plain(p?.placeholder), onFocus: () => { if (!readonly) context.send({ ev: "focus", sf: context.sf, id: node.id }); }, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (!readonly) context.send({ ev: "edit", sf: context.sf, id: node.id, from: 0, to: text.length, text: e.target.value, cursor: e.target.selectionStart ?? e.target.value.length, len: text.length }); } };
	return <div className="space-y-stack">{p?.prompt && <p className="font-medium">{plain(p.prompt)}</p>}{node.k === "editor" ? <textarea {...props} rows={Math.min(12, Math.max(4, text.split("\n").length))} className="tsp-control w-full resize-y font-mono" /> : <Input {...props} />}{!context.readOnly && <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={p?.readonly} onClick={() => action(TSP_ACTIONS.submit)}>{t("tsp.submit")}</Button><Button variant="secondary" onClick={() => action(TSP_ACTIONS.cancel)}>{t("tsp.cancel")}</Button></div>}</div>;
}
