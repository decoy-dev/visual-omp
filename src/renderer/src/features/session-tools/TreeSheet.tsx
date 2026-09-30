/** DESIGN §4.19: navigable map of every branch in a chat's JSONL entry tree. */
import { useEffect, useMemo, useRef, useState } from "react";
import * as RD from "@radix-ui/react-dialog";
import { ArrowCounterClockwise, Minus, Plus, TreeStructure } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button, cn, EmptyState, Expand, Mark, PresenceSwap, spring, toast } from "@/ui";
import { useComposerDrafts } from "../../chat/composer/drafts";
import type { SheetProps } from "../../registry/slots";
import { controllerFor, useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { Markdown } from "../../transcript/Markdown";
import { i18n } from "../../i18n";
import { forkChat, loadTree, navigateTo, NavigationError } from "./navigate";
import { layoutTree, type MapNode, type TreeMap } from "./tree";

interface TreeProps { tabId: string; entryId?: string; }

const NODE_W = 180;
const NODE_H = 40;
const STEP_X = 240;
const STEP_Y = 72;
const PAD = 48;

/** `t` is scoped to `session:tree`. */
function nodeTitle(node: MapNode, t: (key: string) => string): string {
	if (node.kind === "summary") return t("nodes.summary");
	return node.label || t(`nodes.${node.kind}`);
}

function MapCanvas({ map, selected, onSelect }: { map: TreeMap; selected: string | null; onSelect(id: string): void }) {
	const { t } = useTranslation("session", { keyPrefix: "tree" });
	const [scale, setScale] = useState(0.82);
	const [offset, setOffset] = useState({ x: 16, y: 16 });
	const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
	const canvasRef = useRef<HTMLDivElement>(null);
	const width = Math.max(800, map.columns * STEP_X + PAD * 2);
	const height = Math.max(280, map.lanes * STEP_Y + PAD * 2);
	const byId = useMemo(() => new Map(map.nodes.map(node => [node.id, node])), [map.nodes]);
	const picked = selected ? byId.get(selected) : undefined;

	useEffect(() => {
		const element = canvasRef.current;
		if (!element) return;
		const key = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey)) return;
			if (event.key === "+" || event.key === "=") { event.preventDefault(); setScale(value => Math.min(2.2, value + 0.1)); }
			else if (event.key === "-") { event.preventDefault(); setScale(value => Math.max(0.35, value - 0.1)); }
			else if (event.key === "0") { event.preventDefault(); setScale(0.82); setOffset({ x: 16, y: 16 }); }
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, []);

	return (
		<div
			ref={canvasRef}
			className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-inset active:cursor-grabbing"
			onWheel={event => {
				if (event.ctrlKey || event.metaKey) { event.preventDefault(); setScale(value => Math.max(0.35, Math.min(2.2, value - event.deltaY * 0.001))); }
			}}
			onPointerDown={event => {
				if ((event.target as HTMLElement).closest("button")) return;
				drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={event => {
				if (!drag.current) return;
				setOffset({ x: drag.current.ox + event.clientX - drag.current.x, y: drag.current.oy + event.clientY - drag.current.y });
			}}
			onPointerUp={() => { drag.current = null; }}
		>
			<svg
				role="tree"
				aria-label={t("nodes.aria")}
				viewBox={`0 0 ${width} ${height}`}
				className="h-full w-full"
				preserveAspectRatio="xMinYMin meet"
			>
				<g transform={`translate(${offset.x} ${offset.y}) scale(${scale})`}>
					{map.nodes.map(node => {
						const parent = node.parentId ? byId.get(node.parentId) : undefined;
						if (!parent) return null;
						const x1 = PAD + parent.column * STEP_X + NODE_W;
						const y1 = PAD + parent.lane * STEP_Y + NODE_H / 2;
					const x2 = PAD + node.column * STEP_X;
						const y2 = PAD + node.lane * STEP_Y + NODE_H / 2;
						const middle = (x1 + x2) / 2;
						return <path key={`edge:${node.id}`} d={`M ${x1} ${y1} H ${middle} V ${y2} H ${x2}`} fill="none" stroke="var(--border-strong)" strokeWidth={2} />;
					})}
					{map.nodes.map(node => {
						const x = PAD + node.column * STEP_X;
						const y = PAD + node.lane * STEP_Y;
						const tone = node.kind === "summary" ? "fill-inset" : "fill-panel";
						const title = nodeTitle(node, t);
						return (
							<g key={node.id} role="treeitem" aria-selected={selected === node.id || node.current} aria-label={`${t(`nodes.${node.kind}`)}: ${title}`} tabIndex={0} onClick={() => onSelect(node.id)} onKeyDown={event => event.key === "Enter" && onSelect(node.id)} className="group cursor-pointer outline-none">
								<rect x={x} y={y} width={NODE_W} height={NODE_H} rx={10} className={cn(tone, node.current ? "stroke-accent" : "stroke-border", "transition-[stroke] duration-(--dur-fast) group-hover:stroke-border-strong group-focus-visible:stroke-ring")} strokeWidth={node.current ? 1.8 : 1.2} />
								<text x={x + 12} y={y + 16} className={node.kind === "user" ? "fill-fg-muted text-[9px] font-medium" : "fill-fg-faint text-[9px] font-medium"}>{t(`nodes.short.${node.kind}`)}</text>
								<text x={x + 12} y={y + 31} className="fill-fg text-[11px] font-medium">{title.slice(0, 25)}{title.length > 25 ? "…" : ""}</text>
							</g>
						);
					})}
					{/* One selection ring that glides to the picked node, so the eye follows the change of selection. */}
					{picked && (
						<motion.rect
							aria-hidden
							pointerEvents="none"
							x={0}
							y={0}
							width={NODE_W + 8}
							height={NODE_H + 8}
							rx={14}
							fill="none"
							className="stroke-accent"
							strokeWidth={2}
							initial={false}
							animate={{ x: PAD + picked.column * STEP_X - 4, y: PAD + picked.lane * STEP_Y - 4 }}
							transition={spring.snappy}
						/>
					)}
				</g>
			</svg>
			<div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md border border-border bg-panel p-1 shadow-(--shadow-card)">
				<Button size="sm" variant="ghost" aria-label={t("zoomOut")} onClick={() => setScale(value => Math.max(0.35, value - 0.1))}><Minus className="size-3.5" /></Button>
				<span className="w-10 text-center font-mono text-xs text-fg-muted">{Math.round(scale * 100)}%</span>
				<Button size="sm" variant="ghost" aria-label={t("zoomIn")} onClick={() => setScale(value => Math.min(2.2, value + 0.1))}><Plus className="size-3.5" /></Button>
				<Button size="sm" variant="ghost" aria-label={t("fit")} onClick={() => { setScale(0.82); setOffset({ x: 16, y: 16 }); }}><ArrowCounterClockwise className="size-3.5" /></Button>
			</div>
		</div>
	);
}

function TreeSheet({ props, close }: SheetProps<TreeProps>) {
	const { t } = useTranslation("session");
	const session = controllerFor(props.tabId);
	const [map, setMap] = useState<TreeMap | null>(null);
	const [selected, setSelected] = useState<string | null>(props.entryId ?? null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!session) return;
		let live = true;
		void loadTree(session).then(tree => {
			if (!live) return;
			const next = layoutTree(tree);
			setMap(next);
			setSelected(current => current ?? tree.leafId ?? next.nodes.at(-1)?.id ?? null);
		}).catch(reason => live && setError(reason instanceof Error ? reason.message : String(reason)));
		return () => { live = false; };
	}, [session]);

	if (!session) return null;
	const node = map?.nodes.find(item => item.id === selected) ?? null;
	const act = async (fork: boolean) => {
		if (!node) return;
		setBusy(true);
		try {
			if (fork) await forkChat(session, node.entryId);
			else await navigateTo(session, node.entryId);
			if (!fork) {
				const entry = node.kind === "user" ? map?.nodes.find(item => item.id === node.id) : null;
				const maybeEntry = entry?.text;
				if (node.kind === "user" && maybeEntry) useComposerDrafts.getState().setDraft(session.tabId, maybeEntry);
			}
			close();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
			toast({ tone: "warn", message: reason instanceof Error ? reason.message : String(reason), action: { label: t("tree.openTerminal"), onClick: () => { void session.command("/tree"); useApp.getState().openTerminal(session.tabId); } } });
		} finally { setBusy(false); }
	};

	const title = t("tree.title");
	return (
		<RD.Root open onOpenChange={open => !open && close()}>
			<RD.Portal>
				<RD.Overlay className="vo-scrim fixed inset-0 z-(--z-scrim) bg-backdrop" />
				<RD.Content className="vo-dialog fixed left-1/2 top-1/2 z-(--z-sheet) flex h-[min(640px,calc(100vh-64px))] w-[min(960px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-overlay text-fg shadow-(--shadow-overlay) outline-none">
					<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
						<Mark size={20} title={title} />
						<div className="min-w-0 flex-1"><RD.Title className="text-lg font-semibold">{title}</RD.Title><RD.Description className="text-sm text-fg-muted">{t("tree.description")}</RD.Description></div>
						<Button size="sm" variant="ghost" onClick={close}>{t("common.close")}</Button>
					</header>
					<Expand open={error !== null}>
						<div role="alert" className="border-b border-err/30 bg-err-bg px-4 py-2 text-sm text-err">{error}</div>
					</Expand>
					<div className="flex min-h-0 flex-1">
						{map && map.nodes.length > 0 ? <MapCanvas map={map} selected={selected} onSelect={setSelected} /> : <div className="flex flex-1 items-center justify-center p-6"><EmptyState icon={<TreeStructure />} title={error ?? t("tree.empty")} body={t("tree.emptyHint")} /></div>}
						<aside className="flex w-80 shrink-0 flex-col border-l border-border bg-panel p-4">
							{/* Crossfade the preview when the selection moves, so the swap reads as a new selection. */}
							<PresenceSwap swapKey={node?.id ?? "none"} className="flex min-h-0 flex-1 flex-col">
								{node ? (
									<>
										<h3 className="text-md font-semibold text-fg">{node.label || t(`tree.nodes.${node.kind}`)}</h3>
										<p className="mt-1 text-xs text-fg-faint">{[node.label ? t(`tree.nodes.${node.kind}`) : null, node.timestamp].filter(Boolean).join(" · ")}</p>
										<div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md bg-inset p-3 text-sm"><Markdown text={node.text || t("tree.noText")} /></div>
										<div className="mt-3 flex flex-col gap-2">
											<Button variant="ghost" disabled={busy} onClick={() => void act(false)}>{t(node.kind === "user" ? "tree.rewind" : "tree.resume")}</Button>
											<Button variant="secondary" disabled={busy} onClick={() => void act(true)}>{t("tree.fork")}</Button>
										</div>
									</>
								) : (
									<p className="text-sm text-fg-muted">{t("tree.selectHint")}</p>
								)}
							</PresenceSwap>
							{map && !map.branched && <p className="mt-4 text-xs text-fg-faint">{t("tree.noBranches")}</p>}
						</aside>
					</div>
					<footer className="flex h-8 shrink-0 items-center justify-between border-t border-border px-4 text-xs text-fg-faint"><span>{t("tree.panHint")}</span><span>⌘+/−/0 {t("tree.zoomHint")}</span></footer>
				</RD.Content>
			</RD.Portal>
		</RD.Root>
	);
}

export { TreeSheet };
