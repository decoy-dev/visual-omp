import type { TspKind, TspMenuItem, TspNode } from "@shared/tsp";
import { shellProps } from "@shared/tsp/shell";
import type { TerminalColors } from "@shared/contracts/native";
import { isHookNode, isKnownAction, isKnownRole, TSP_ACTIONS } from "@shared/tsp/roles";
import { HookDialog } from "../interactive/HookDialog";
import { CaretDown, CheckCircle, Circle, DotsThree, File, Globe, Image, Info, Warning } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../../../transcript/Markdown";
import { DiffBlock } from "../../../tool-render/parts";
import { Button } from "../../../ui/Button";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../../../ui/Menu";
import { ansiRuns } from "../ansi";
import { Choice } from "../interactive/Choice";
import { Forms } from "../interactive/Forms";
import { PushButton } from "../interactive/PushButton";
import { Segmented } from "../../../ui/Segmented";
import { Code } from "./Code";
import { plain } from "../../../state/tsp/labels";
import { rawKey } from "../keys";
import type { NodeContext, NodeProps } from "./context";
import { Live } from "./Live";
import { Table } from "./Table";
import { KeyCombinations } from "../../../ui/KeyCombinations";
import { lazyView, LoadFailedNotice } from "../../../registry/lazy";

const FieldTree = lazy(() => import("../../../tool-render/structured").then(module => ({ default: module.FieldTree })));
function ShellLoading() {
	const { t } = useTranslation("session");
	return <p className="max-h-24 overflow-auto rounded-sm bg-inset p-card text-sm text-fg-muted">{t("common.loading")}</p>;
}
const ShellView = lazyView(() => import("../../shell-visualization/ShellView").then(module => module.ShellView), ShellLoading, LoadFailedNotice);
export const KIND_GROUPS = {
	col: "container", row: "container", card: "container", section: "container", rule: "container", spacer: "container", overlay: "container",
	text: "text", md: "text", doc: "text", code: "text", diff: "text", math: "text", kbd: "text", badge: "text", icon: "text", status: "text", seg: "text",
	list: "choice", item: "choice", picker: "choice", tabs: "choice", checklist: "choice", tree: "choice", table: "choice", kv: "choice", menu: "choice",
	prefs: "form", input: "form", editor: "form", effort: "form", button: "form", buttons: "form",
	spinner: "live", shimmer: "live", elapsed: "live", progress: "live", meter: "live", rate: "live", chart: "live",
	tool: "work", agent: "work", json: "work", shell: "work", image: "media", media: "media", web: "media", toast: "notice", rows: "fallback", ansi: "fallback",
} as const satisfies Record<TspKind, string>;
const warned = new Set<string>();
function copyText(node: TspNode): string {
	if (node.k === "text" || node.k === "shimmer") return plain(node.p?.spans ?? node.p?.text);
	if (node.k === "md" || node.k === "doc" || node.k === "code" || node.k === "ansi" || node.k === "math" || node.k === "input" || node.k === "editor") return node.p?.text ?? "";
	return node.c?.map(copyText).filter(Boolean).join(" ") ?? "";
}
function warnOnce(key: string) { if (!warned.has(key)) { warned.add(key); console.warn(`TSP screen fallback: ${key}`); } }
function isMenuSeparator(item: TspMenuItem): boolean {
	return item === "-" || item === "---";
}
function warnMenuActions(items: readonly TspMenuItem[] | undefined): void {
	if (!items) return;
	for (const item of items) {
		if (typeof item === "string") {
			if (!isMenuSeparator(item) && !isKnownAction(item)) warnOnce(`action:${item}`);
			continue;
		}
		if ("header" in item) continue;
		if (item.items?.length) { warnMenuActions(item.items); continue; }
		if (!isKnownAction(item.id)) warnOnce(`action:${item.id}`);
	}
}
function warnUnsupportedActions(node: TspNode): void {
	const actions = node.p?.actions;
	const declared = Array.isArray(actions) ? actions.map(action => action.id) : [actions?.click, actions?.dblclick, ...(actions?.menu ?? [])];
	for (const action of declared) if (action && !isKnownAction(action)) warnOnce(`action:${action}`);
	if (node.k === "prefs") for (const section of node.p?.sections ?? []) for (const row of section.rows) {
		if (row.control.k === "action" && !isKnownAction(row.control.act)) warnOnce(`action:${row.control.act}`);
	}
	if (node.k === "menu") warnMenuActions(node.p?.items);
	// List items are drawn by Choice rather than recursively mounted as NodeView.
	if (node.k === "list") for (const child of node.c ?? []) if (child.k === "item") {
		if (!isKnownRole(child.p?.role)) warnOnce(`role:${child.p?.role}`);
		warnUnsupportedActions(child);
	}
}
/** Whether a descendant takes its own clicks, such as the option pills inside a folded question of omp 19's ask card. */
function hasOwnControls(node: TspNode): boolean {
	return node.c?.some(child => child.k === "button" || child.k === "menu" || (!Array.isArray(child.p?.actions) && !!child.p?.actions?.click) || hasOwnControls(child)) ?? false;
}
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
	const content = props?.text ?? props?.spans ?? props?.label ?? props?.title ?? props?.head;
	const readable = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap(span => span && typeof span === "object" && "t" in span && typeof span.t === "string" ? [span.t] : []).join("") : "";
	const text = node.k === "rows" ? node.p?.lines.join("\n") ?? "" : node.k === "ansi" ? node.p?.text ?? "" : readable || t("tsp.unsupportedKind", { kind: node.k });
	// Raw rows/ANSI already belong to omp's key target; browser focus must not add a semantic write.
	const onFocus = node.k === "rows" || node.k === "ansi" ? undefined : () => { if (!context.readOnly) context.send({ ev: "focus", sf: context.sf, id: node.id }); };
	return <div className="space-y-2"><pre tabIndex={0} aria-label={node.p?.aria ?? t("tsp.rawOutput")} style={{ color: palette?.foreground, backgroundColor: palette?.background }} className="overflow-auto whitespace-pre-wrap break-words rounded-sm bg-inset p-card font-mono text-code" onFocus={onFocus} onKeyDown={event => { if (context.readOnly) return; const key = rawKey(event); if (key) { event.preventDefault(); event.stopPropagation(); context.keys(key); } }} onPaste={event => { if (!context.readOnly) { event.preventDefault(); context.keys(event.clipboardData.getData("text")); } }}>{ansiRuns(text, palette?.ansi).map((run, i) => <span key={i} style={run.style}>{run.text}</span>)}</pre>{node.c?.map(child => context.render(child))}</div>;
}
function Body({ node, context }: NodeProps) {
	const { t } = useTranslation("palette");
	const children = node.c?.map(child => context.render(child));
	switch (node.k) {
		case "overlay": return <section role="dialog" aria-label={plain(node.p?.head) || t("tsp.title")} className="space-y-stack">{children}</section>;
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
		case "md": case "doc": return <Markdown text={node.p?.text ?? ""} />;
		case "code": return <Code p={node.p} />;
		case "shell": {
			const props = shellProps(node.p);
			if (!props) return <p className="max-h-24 overflow-auto rounded-sm bg-inset p-card text-sm text-fg-muted">{t("tsp.shellUnavailable")}</p>;
			const jobsStep = props.steps === true && (node.p?.role === "omp.jobs.command" || context.role === "omp.overlay.jobs");
			return <ShellView key={`${context.sf}:${node.id}`} props={props} allowReplay={!jobsStep} disabled={context.readOnly} onAction={value => { if (!context.readOnly) context.send({ ev: "action", sf: context.sf, id: node.id, act: "shell-viz", value }); }} />;
		}
		// omp wraps a diff's long lines unless the node says `wrap: false` (omp 18.22.1's git app toggles it).
		case "diff": return <DiffBlock wrap={node.p?.wrap !== false} diff={node.p?.text ?? node.p?.hunks?.flatMap(hunk => [`@@ -${hunk.oldStart} +${hunk.newStart} @@`, ...hunk.lines]).join("\n") ?? ""} />;
		case "math": return <Markdown text={`$$\n${node.p?.text ?? ""}\n$$`} />;
		case "kbd": return node.p?.keys.length ? <KeyCombinations value={[{ t: node.p.keys.join("+"), s: "key" }]} /> : null;
		case "badge": return <span className="rounded-sm bg-inset px-2 py-1 text-xs">{node.p?.text}</span>;
		case "icon": { const name = node.p?.name ?? ""; const Icon = /warn|error/.test(name) ? Warning : /check|done|success/.test(name) ? CheckCircle : /file/.test(name) ? File : Info; return <Icon className="size-4 shrink-0" aria-label={node.p?.aria ?? name} />; }
		case "status": return <div role="status" className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">{children}</div>;
		case "list": case "picker": case "tree": return <Choice node={node} context={context} />;
		case "item": return <div className="py-2"><p>{plain(node.p?.label)}</p>{node.p?.detail && <p className="text-sm text-fg-muted">{plain(node.p.detail)}</p>}{children}</div>;
		case "button": return <PushButton node={node} context={context} />;
		case "buttons": return <div role="group" aria-label={node.p?.label} className="flex flex-wrap items-center gap-2">{children}</div>;
		case "menu": {
			const items = node.p?.items ?? [];
			const disabled = context.readOnly || !!node.p?.disabled;
			const variant = node.p?.trigger === "primary" ? "primary" : node.p?.trigger === "quiet" ? "ghost" : "secondary";
			const renderItems = (list: readonly TspMenuItem[]) => {
				const rendered = [];
				for (let index = 0; index < list.length; index++) {
					const item = list[index]!;
					if (typeof item === "string") {
						if (isMenuSeparator(item)) { rendered.push(<MenuSeparator key={`sep-${index}`} />); continue; }
						const known = isKnownAction(item);
						rendered.push(<MenuItem key={`${index}:${item}`} disabled={context.readOnly || !known} onSelect={() => context.send({ ev: "action", sf: context.sf, id: node.id, act: item })}>{item}</MenuItem>);
						continue;
					}
					if ("header" in item) { rendered.push(<MenuLabel key={`hdr-${index}`}>{item.header}</MenuLabel>); continue; }
					if (item.radio) {
						const groupName = item.radio;
						const groupItems = [item];
						while (index + 1 < list.length) {
							const next = list[index + 1]!;
							if (typeof next === "string" || "header" in next || next.radio !== groupName) break;
							groupItems.push(next);
							index++;
						}
						const activeValue = groupItems.find(entry => entry.checked)?.id ?? "";
						rendered.push(
							<MenuRadioGroup key={`radio-${groupName}-${index}`} value={activeValue}>
								{groupItems.map(entry => {
									const known = isKnownAction(entry.id);
									const itemDisabled = context.readOnly || !!entry.disabled || !known;
									const shortcut = typeof entry.keys === "string" ? entry.keys : entry.keys?.join("+");
									// A radio row's action carries its new checked state, which is always true once chosen (wire `tsp.ts`, `ev: "action"`).
									return <MenuRadioItem key={entry.id} value={entry.id} disabled={itemDisabled} shortcut={shortcut} description={entry.detail} onSelect={() => context.send({ ev: "action", sf: context.sf, id: node.id, act: entry.id, checked: true })}>{entry.label ?? entry.id}</MenuRadioItem>;
								})}
							</MenuRadioGroup>,
						);
						continue;
					}
					const known = isKnownAction(item.id);
					const itemDisabled = context.readOnly || !!item.disabled || !known;
					const shortcut = typeof item.keys === "string" ? item.keys : item.keys?.join("+");
					if (typeof item.checked === "boolean") {
						rendered.push(<MenuCheckboxItem key={item.id} checked={item.checked} disabled={itemDisabled} shortcut={shortcut} onCheckedChange={() => context.send({ ev: "action", sf: context.sf, id: node.id, act: item.id, checked: !item.checked })}>{item.label ?? item.id}</MenuCheckboxItem>);
						continue;
					}
					rendered.push(<MenuItem key={item.id} danger={item.danger} disabled={itemDisabled} shortcut={shortcut} onSelect={() => context.send({ ev: "action", sf: context.sf, id: node.id, act: item.id })}>{item.label ?? item.id}</MenuItem>);
				}
				return rendered;
			};
			return (
				<Menu>
					<MenuTrigger asChild>
						<Button size="sm" variant={variant} disabled={disabled} aria-label={node.p?.aria ?? node.p?.text ?? t("tsp.choices")} title={typeof node.p?.disabled === "string" ? node.p.disabled : undefined}>
							{node.p?.text ?? <DotsThree aria-hidden className="size-4" />}
							{node.p?.caret && <CaretDown aria-hidden className="size-3.5" />}
						</Button>
					</MenuTrigger>
					<MenuContent align={node.p?.align === "end" ? "end" : "start"}>{renderItems(items)}</MenuContent>
				</Menu>
			);
		}
		case "tabs": if (node.p?.variant === "segmented") return <Segmented aria-label={node.p.aria ?? t("tsp.choices")} value={node.p.active ?? ""} options={node.p.items.map(item => ({ value: item.id, label: plain(item.label) }))} disabled={context.readOnly} onValueChange={item => context.send({ ev: "select", sf: context.sf, id: node.id, item })} className="max-w-full flex-wrap" />;
			return <div role="tablist" aria-label={node.p?.aria ?? t("tsp.choices")} className="flex flex-wrap gap-2">{node.p?.items.map(item => <button type="button" className="tsp-tab" key={item.id} role="tab" aria-selected={node.p?.active === item.id} disabled={context.readOnly} onClick={() => context.send({ ev: "select", sf: context.sf, id: node.id, item: item.id })}>{plain(item.label)}</button>)}</div>;
		case "kv": return <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2">{node.p?.items.map((item, index) => <div key={index} className="contents"><dt className="text-fg-muted">{plain(item.k)}</dt><dd className="break-words">{plain(item.v)}</dd></div>)}</dl>;
		case "table": return <Table p={node.p} />;
		case "checklist": return <div className="space-y-stack">{node.p?.phases.map(phase => <section key={phase.id}><h4 className="font-semibold">{plain(phase.title)}</h4><ul>{phase.items.map(item => <li className="flex items-start gap-2 py-1" key={item.id}>{item.status === "done" ? <CheckCircle aria-label={item.status} className="mt-0.5 size-4 text-ok" /> : <Circle aria-label={item.status} className="mt-0.5 size-4 text-fg-muted" />}<span>{plain(item.text)}{item.note && <span className="block text-sm text-fg-muted">{plain(item.note)}</span>}</span></li>)}</ul></section>)}</div>;
		case "prefs": case "input": case "editor": case "effort": return <Forms node={node} context={context} />;
		case "spinner": case "shimmer": case "elapsed": case "progress": case "meter": case "rate": case "chart": return <Live node={node} />;
		case "tool": return <section className="space-y-2 py-2"><h4 className="font-semibold">{plain(node.p?.title) || node.p?.name}</h4>{node.p?.target && <p className="break-words font-mono text-code">{plain(node.p.target)}</p>}{node.p?.status && <p className="text-sm text-fg-muted">{node.p.status}</p>}{children}</section>;
		case "agent": return <section className="space-y-2 py-2"><h4 className="font-semibold">{node.p?.name}</h4><p>{plain(node.p?.task)}</p><p className="text-sm text-fg-muted">{node.p?.status}{node.p?.model && ` · ${node.p.model}`}</p>{children}</section>;
		case "json": return <Suspense fallback={<pre className="font-mono text-code">{JSON.stringify(node.p?.value, null, 2)}</pre>}><FieldTree value={node.p?.value} /></Suspense>;
		case "image": case "media": return <div className="flex items-center gap-3 rounded-sm bg-inset p-card text-fg-muted"><Image aria-hidden className="size-5 shrink-0" /><span>{node.k === "image" ? node.p?.alt ?? t("tsp.image") : node.p?.path}<span className="block text-sm">{t("tsp.mediaUnavailable")}</span></span></div>;
		case "web": return <div className="flex items-center gap-3 rounded-sm bg-inset p-card text-fg-muted"><Globe aria-hidden className="size-5 shrink-0" /><span>{node.p?.title ?? node.p?.url}<span className="block text-sm">{t("tsp.mediaUnavailable")}</span></span></div>;
		case "toast": return <p role="status" className="flex items-start gap-2 text-sm"><Info aria-hidden className="mt-0.5 size-4 shrink-0" /><span>{node.p?.text}{node.p?.sub && <span className="block text-fg-muted">{node.p.sub}</span>}</span></p>;
		case "rows": case "ansi": return <Fallback node={node} context={context} />;
		default: warnOnce(`kind:${(node as TspNode).k}`); return <Fallback node={node} context={context} />;
	}
}
export function NodeView({ node, context }: NodeProps) {
	const { t } = useTranslation("palette");
	// HookDialog supplies a scoped context on the recursive render.
	if (node.p?.hidden) return null;
	if (!isKnownRole(node.p?.role)) warnOnce(`role:${node.p?.role}`);
	const hook = isHookNode(node);
	if (hook && context.hook?.id !== node.id) return <HookDialog node={node} context={context} />;
	const role = node.p?.role ?? context.role;
	const actions = node.p?.actions;
	warnUnsupportedActions(node);
	const readOnly = context.readOnly;
	const childContext: NodeContext = { ...context, role, readOnly, render: (child, ro = readOnly) => <NodeView key={child.id} node={child} context={{ ...context, role, readOnly: ro }} /> };
	const click = !Array.isArray(actions) ? actions?.click : undefined;
	const unsupportedClick = !!click && !isKnownAction(click);
	const content = <Body node={node} context={childContext} />;
	const actionable = click && !["button", "buttons", "menu", "list", "picker", "tree", "item", "tool", "agent", "json", "shell"].includes(node.k);
	if (actionable && unsupportedClick) return <div data-tsp-kind={node.k} data-tsp-id={node.id} className="min-w-0 space-y-stack">{content}<Button variant="secondary" disabled title={t("tsp.unsupportedAction", { action: click })}>{t("tsp.unavailableAction")}</Button></div>;
	const activate = () => {
		if (click === TSP_ACTIONS.copy) void navigator.clipboard.writeText(copyText(node));
		else if (click === "toggle") context.send({ ev: "toggle", sf: context.sf, id: node.id, collapsed: node.k === "card" || node.k === "section" ? !node.p?.collapsed : true });
		else if (click) context.send({ ev: "action", sf: context.sf, id: node.id, act: click });
	};
	// A button inside a button would send both clicks and hide the inner one from assistive technology, so a container
	// with its own controls keeps them and offers its click as a separate button named by omp's title.
	if (actionable && hasOwnControls(node)) return <div data-tsp-kind={node.k} data-tsp-id={node.id} className="min-w-0 space-y-stack">{content}<Button size="sm" variant="secondary" disabled={readOnly} onClick={activate}>{node.p?.title ?? t("tsp.openAction")}</Button></div>;
	return <div data-tsp-kind={node.k} data-tsp-id={node.id} className="min-w-0">{actionable ? <Button variant="secondary" disabled={readOnly} onClick={activate}>{content}</Button> : content}</div>;
}
