import type { TspKind, TspNode } from "@shared/tsp";
import type { TerminalColors } from "@shared/contracts/native";
import { isHookDialog, isKnownAction, isKnownRole, TSP_ACTIONS } from "@shared/tsp/roles";
import { CheckCircle, Circle, File, Image, Info, Warning } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../../../transcript/Markdown";
import { CodeBlock, DiffBlock } from "../../../tool-render/parts";
import { Button } from "../../../ui/Button";
import { ansiRuns } from "../ansi";
import { Choice } from "../interactive/Choice";
import { Forms } from "../interactive/Forms";
import { plain } from "../labels";
import { rawKey } from "../keys";
import type { NodeContext, NodeProps } from "./context";
import { Live } from "./Live";
import { KeyCombinations, Table } from "./Table";

const FieldTree = lazy(() => import("../../../tool-render/structured").then(module => ({ default: module.FieldTree })));
export const KIND_GROUPS = {
	col: "container", row: "container", card: "container", section: "container", rule: "container", spacer: "container", overlay: "container",
	text: "text", md: "text", code: "text", diff: "text", math: "text", kbd: "text", badge: "text", icon: "text", status: "text", seg: "text",
	list: "choice", item: "choice", picker: "choice", tabs: "choice", checklist: "choice", tree: "choice", table: "choice", kv: "choice",
	prefs: "form", input: "form", editor: "form", effort: "form",
	spinner: "live", shimmer: "live", elapsed: "live", progress: "live", meter: "live", rate: "live", chart: "live",
	tool: "work", agent: "work", json: "work", image: "media", media: "media", toast: "notice", rows: "fallback", ansi: "fallback",
} as const satisfies Record<TspKind, string>;
const warned = new Set<string>();
function copyText(node: TspNode): string {
	if (node.k === "text" || node.k === "shimmer") return plain(node.p?.spans ?? node.p?.text);
	if (node.k === "md" || node.k === "code" || node.k === "ansi" || node.k === "math" || node.k === "input" || node.k === "editor") return node.p?.text ?? "";
	return node.c?.map(copyText).filter(Boolean).join(" ") ?? "";
}
function warnOnce(key: string) { if (!warned.has(key)) { warned.add(key); console.warn(`TSP screen fallback: ${key}`); } }
function Fallback({ node, context }: NodeProps) {
	const { t } = useTranslation("palette");
	const [palette, setPalette] = useState<TerminalColors | null>(null);
	useEffect(() => {
		if (!context.hostId) return;
		let live = true;
		let request = 0;
		const refresh = () => {
			const current = ++request;
			void window.vomp.invoke("native:terminalTheme", context.hostId!).then(next => { if (live && current === request) setPalette(next); }).catch(() => undefined);
		};
		refresh();
		const off = window.vomp.on("native:changed", event => { if (event.hostId === context.hostId) refresh(); });
		return () => { live = false; off(); };
	}, [context.hostId]);
	const props = node.p as Record<string, unknown> | undefined;
	const text = node.k === "rows" ? node.p?.lines.join("\n") ?? "" : node.k === "ansi" ? node.p?.text ?? "" : JSON.stringify(props ?? {}, null, 2);
	return <div className="space-y-2"><pre tabIndex={0} aria-label={node.p?.aria ?? t("tsp.rawOutput")} style={{ color: palette?.foreground, backgroundColor: palette?.background }} className="overflow-auto whitespace-pre-wrap break-words rounded-sm bg-inset p-card font-mono text-code" onFocus={() => { if (!context.readOnly) context.send({ ev: "focus", sf: context.sf, id: node.id }); }} onKeyDown={event => { if (context.readOnly) return; const key = rawKey(event); if (key) { event.preventDefault(); event.stopPropagation(); context.keys(key); } }} onPaste={event => { if (!context.readOnly) { event.preventDefault(); context.keys(event.clipboardData.getData("text")); } }}>{ansiRuns(text, palette?.ansi).map((run, i) => <span key={i} style={run.style}>{run.text}</span>)}</pre>{node.c?.map(child => context.render(child))}</div>;
}
function Body({ node, context }: NodeProps) {
	const { t } = useTranslation("palette");
	const children = node.c?.map(child => context.render(child));
	switch (node.k) {
		case "overlay": return <section role="group" aria-label={plain(node.p?.head) || t("tsp.title")} className="space-y-stack">{children}</section>;
		case "col": return <div className="space-y-stack">{children}</div>;
		case "row": return <div className="flex flex-wrap items-center gap-3">{children}</div>;
		case "card": case "section": {
			const p = node.p;
			if (p?.collapsible) return <details open={!p.collapsed} onToggle={event => { const collapsed = !event.currentTarget.open; if (!context.readOnly && collapsed !== !!p.collapsed) context.send({ ev: "toggle", sf: context.sf, id: node.id, collapsed }); }}><summary className="cursor-pointer py-2 font-semibold">{plain(p.head)}</summary><div className="space-y-stack">{children}</div></details>;
			return <section className="tsp-section">{p?.head && <h3 className="font-semibold">{plain(p.head)}</h3>}{children}</section>;
		}
		case "rule": return <div className="flex items-center gap-3 py-2 text-sm text-fg-muted"><hr className="flex-1 border-border" />{plain(node.p?.label)}{node.p?.label && <hr className="flex-1 border-border" />}</div>;
		case "spacer": return <div className={node.p?.size === "lg" ? "h-section" : "h-stack"} />;
		case "text": return <p className="whitespace-pre-wrap break-words">{plain(node.p?.spans ?? node.p?.text)}</p>;
		case "seg": return <span className="whitespace-pre-wrap">{plain(node.p?.spans)}</span>;
		case "md": return <Markdown text={node.p?.text ?? ""} />;
		case "code": return <CodeBlock code={node.p?.text ?? ""} lang={node.p?.lang} title={node.p?.path} />;
		case "diff": return <DiffBlock diff={node.p?.text ?? node.p?.hunks?.flatMap(hunk => [`@@ -${hunk.oldStart} +${hunk.newStart} @@`, ...hunk.lines]).join("\n") ?? ""} />;
		case "math": return <Markdown text={`$$\n${node.p?.text ?? ""}\n$$`} />;
		case "kbd": return node.p?.keys.length ? <KeyCombinations value={[{ t: node.p.keys.join("+"), s: "key" }]} /> : null;
		case "badge": return <span className="rounded-sm bg-inset px-2 py-1 text-xs">{node.p?.text}</span>;
		case "icon": { const name = node.p?.name ?? ""; const Icon = /warn|error/.test(name) ? Warning : /check|done|success/.test(name) ? CheckCircle : /file/.test(name) ? File : Info; return <Icon className="size-4 shrink-0" aria-label={node.p?.aria ?? name} />; }
		case "status": return <div role="status" className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">{children}</div>;
		case "list": case "picker": case "tree": return <Choice node={node} context={context} />;
		case "item": return <div className="py-2"><p>{plain(node.p?.label)}</p>{node.p?.detail && <p className="text-sm text-fg-muted">{plain(node.p.detail)}</p>}{children}</div>;
		case "tabs": return <div role="tablist" aria-label={node.p?.aria ?? t("tsp.choices")} className="flex flex-wrap gap-2">{node.p?.items.map(item => <button type="button" className="tsp-tab" key={item.id} role="tab" aria-selected={node.p?.active === item.id} disabled={context.readOnly} onClick={() => context.send({ ev: "select", sf: context.sf, id: node.id, item: item.id })}>{plain(item.label)}</button>)}</div>;
		case "kv": return <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2">{node.p?.items.map((item, index) => <div key={index} className="contents"><dt className="text-fg-muted">{plain(item.k)}</dt><dd className="break-words">{plain(item.v)}</dd></div>)}</dl>;
		case "table": return <Table p={node.p} />;
		case "checklist": return <div className="space-y-stack">{node.p?.phases.map(phase => <section key={phase.id}><h4 className="font-semibold">{plain(phase.title)}</h4><ul>{phase.items.map(item => <li className="flex items-start gap-2 py-1" key={item.id}>{item.status === "done" ? <CheckCircle aria-label={item.status} className="mt-0.5 size-4 text-ok" /> : <Circle aria-label={item.status} className="mt-0.5 size-4 text-fg-muted" />}<span>{plain(item.text)}{item.note && <span className="block text-sm text-fg-muted">{plain(item.note)}</span>}</span></li>)}</ul></section>)}</div>;
		case "prefs": case "input": case "editor": case "effort": return <Forms node={node} context={context} />;
		case "spinner": case "shimmer": case "elapsed": case "progress": case "meter": case "rate": case "chart": return <Live node={node} />;
		case "tool": return <section className="space-y-2 py-2"><h4 className="font-semibold">{plain(node.p?.title) || node.p?.name}</h4>{node.p?.target && <p className="break-words font-mono text-code">{plain(node.p.target)}</p>}{node.p?.status && <p className="text-sm text-fg-muted">{node.p.status}</p>}{children}</section>;
		case "agent": return <section className="space-y-2 py-2"><h4 className="font-semibold">{node.p?.name}</h4><p>{plain(node.p?.task)}</p><p className="text-sm text-fg-muted">{node.p?.status}{node.p?.model && ` · ${node.p.model}`}</p>{children}</section>;
		case "json": return <Suspense fallback={<pre className="font-mono text-code">{JSON.stringify(node.p?.value, null, 2)}</pre>}><FieldTree value={node.p?.value} /></Suspense>;
		case "image": case "media": return <div className="flex items-center gap-3 rounded-sm bg-inset p-card text-fg-muted"><Image aria-hidden className="size-5 shrink-0" /><span>{node.k === "image" ? node.p?.alt ?? t("tsp.image") : node.p?.path}<span className="block text-sm">{t("tsp.mediaUnavailable")}</span></span></div>;
		case "toast": return <p role="status" className="flex items-start gap-2 text-sm"><Info aria-hidden className="mt-0.5 size-4 shrink-0" /><span>{node.p?.text}{node.p?.sub && <span className="block text-fg-muted">{node.p.sub}</span>}</span></p>;
		case "rows": case "ansi": return <Fallback node={node} context={context} />;
		default: warnOnce(`kind:${(node as TspNode).k}`); return <Fallback node={node} context={context} />;
	}
}
export function NodeView({ node, context }: NodeProps) {
	const { t } = useTranslation("palette");
	if (node.p?.hidden) return null;
	if (!isKnownRole(node.p?.role)) { warnOnce(`role:${node.p?.role}`); return <Fallback node={node} context={context} />; }
	const hook = isHookDialog(node.p?.role);
	const readOnly = context.readOnly || hook;
	const role = node.p?.role ?? context.role;
	const childContext: NodeContext = { ...context, role, readOnly, render: (child, ro = readOnly) => <NodeView key={child.id} node={child} context={{ ...context, role, readOnly: ro }} /> };
	const actions = node.p?.actions;
	const click = !Array.isArray(actions) ? actions?.click : undefined;
	const unknownAction = Array.isArray(actions)
		? actions.find(action => !isKnownAction(action.id))?.id
		: [actions?.click, actions?.dblclick, ...(actions?.menu ?? [])].find(action => action && !isKnownAction(action));
	if (unknownAction) { warnOnce(`action:${unknownAction}`); return <Fallback node={node} context={childContext} />; }
	const content = <Body node={node} context={childContext} />;
	const actionable = click && !["list", "picker", "tree", "item", "tool", "agent", "json"].includes(node.k);
	return <div data-tsp-kind={node.k} data-tsp-id={node.id} className="min-w-0">{hook && <p role="note" className="mb-card rounded-sm bg-inset p-3 text-sm text-fg-muted">{t("tsp.hookReadOnly")}</p>}{actionable ? <Button variant="secondary" disabled={readOnly} onClick={() => {
		if (click === TSP_ACTIONS.copy) void navigator.clipboard.writeText(copyText(node));
		else if (click === "toggle") context.send({ ev: "toggle", sf: context.sf, id: node.id, collapsed: node.k === "card" || node.k === "section" ? !node.p?.collapsed : true });
		else context.send({ ev: "action", sf: context.sf, id: node.id, act: click });
	}}>{content}</Button> : content}</div>;
}
