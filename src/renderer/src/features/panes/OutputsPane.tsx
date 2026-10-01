/**
 * Outputs pane (DESIGN §3.7): the images and files omp made or showed in the focused chat, newest first.
 * Images load from disk when they have a path, so a re-rendered file shows its current state; images
 * without a file fall back to the data in the tool result (or omp's blob store for saved chats).
 * Clicking an image opens a larger view with Open, Show in folder and Copy path; clicking a file opens
 * it in the Files pane.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { ArrowLeft, ArrowSquareOut, Copy, FileCode, FileIcon, FolderSimpleDashed, ImageBroken, Images } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { PaneProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { activeBranch, type SavedParents, savedParents } from "../../state/history";
import { liveEntries, type SessionController, type SessionView } from "../../state/session";
import { Badge, cn, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, EmptyState, IconButton, PresenceSwap, toast } from "../../ui";
import { focusRingInset } from "../../ui/styles";
import { errorText } from "../extensions/format";
import { useHomeDir } from "../projects/folders/FolderBrowser";
import { listRowMotion, PaneToolbar, relativePath, Section, usePaneVisible } from "./common";
import { type ChatOutput, chatOutputs, IMAGE_EXT, isIntactBase64, RASTER_EXT } from "./derive";
import { openInFiles } from "./FilesPane";
import { languageFor } from "./highlight";

// ── outputs of the focused chat ─────────────────────────────────────────────────────────────────

interface Derived {
	leaf: string | null;
	saved: SavedParents | undefined;
	cwd: string | null;
	home: string | null;
	outputs: ChatOutput[];
}

/** Keyed by the session's entry list, so the pane and its tab badge share one derivation per update. */
const derived = new WeakMap<readonly SessionEntry[], Derived>();

/**
 * The chat's outputs from the entries the transcript shows: the live stream's active branch, else the saved
 * history. Null until either has loaded.
 */
function useChatOutputs(session: SessionController | null, view: SessionView | null): ChatOutput[] | null {
	const home = useHomeDir();
	const liveSource = liveEntries(view);
	const live = liveSource !== null;
	const source = liveSource ?? view?.history?.entries ?? null;
	const leaf = live ? (view?.displayLeaf ?? null) : null;
	const saved = live ? savedParents(view?.history) : undefined;
	const cwd = view?.history?.header?.cwd ?? session?.projectPath ?? null;
	return useMemo(() => {
		if (!source) return null;
		const cached = derived.get(source);
		if (cached && cached.leaf === leaf && cached.saved === saved && cached.cwd === cwd && cached.home === home) return cached.outputs;
		const outputs = chatOutputs(live ? activeBranch(source, leaf, saved) : source, { cwd, home });
		derived.set(source, { leaf, saved, cwd, home, outputs });
		return outputs;
	}, [source, live, leaf, saved, cwd, home]);
}

function baseName(path: string): string {
	return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || path;
}

/** Labels for images without a file, by the tool that made them. */
const INLINE_LABEL: Record<string, string> = {
	generate_image: "outputs.inline.generated",
	browser: "outputs.inline.browser",
	eval: "outputs.inline.screenshot",
};

/** How each tool made or showed an output ("Edited 14:32"). */
const WHEN_LABEL: Record<string, string> = {
	write: "outputs.when.written",
	edit: "outputs.when.edited",
	ast_edit: "outputs.when.edited",
	read: "outputs.when.viewed",
	generate_image: "outputs.when.generated",
};

function useOutputName(output: ChatOutput): string {
	const { t } = useTranslation("panes");
	if (output.path) return baseName(output.path);
	return t(Object.hasOwn(INLINE_LABEL, output.tool) ? INLINE_LABEL[output.tool] : "outputs.inline.other");
}

/** Time today, else the date only, so the label stays short in a narrow dock. */
function formatTime(time: number): string {
	const date = new Date(time);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function useWhen(output: ChatOutput): string {
	const { t } = useTranslation("panes");
	return t(Object.hasOwn(WHEN_LABEL, output.tool) ? WHEN_LABEL[output.tool] : "outputs.when.captured", { time: formatTime(output.time) });
}

// ── image loading ───────────────────────────────────────────────────────────────────────────────

const IMAGE_CACHE_LIMIT = 24;
/** Image sources by `<pane mount>|<key>@<time>`: a reopened pane, or a newer use of the same file, reads it again. */
const imageCache = new Map<string, Promise<string | null>>();
let paneMounts = 0;

/** The file on disk first (its current version), then intact inline data, then omp's blob store; null when none works. */
async function loadImage(output: ChatOutput): Promise<string | null> {
	if (output.path && IMAGE_EXT.test(output.path)) {
		const file = await window.vomp.invoke("panes:readFile", output.path).catch(() => null);
		if (file?.kind === "image") return file.dataUrl;
	}
	const inline = output.inline;
	if (inline?.kind === "data") return isIntactBase64(inline.data) ? `data:${inline.mimeType};base64,${inline.data}` : null;
	if (inline?.kind === "blob") return window.vomp.invoke("panes:readBlob", inline.hash).catch(() => null);
	return null;
}

function cachedImage(output: ChatOutput, mount: number): Promise<string | null> {
	const key = `${mount}|${output.key}@${output.time}`;
	let pending = imageCache.get(key);
	if (!pending) {
		pending = loadImage(output);
		imageCache.set(key, pending);
		for (const old of imageCache.keys()) {
			if (imageCache.size <= IMAGE_CACHE_LIMIT) break;
			imageCache.delete(old);
		}
	}
	return pending;
}

/** `undefined` while loading (or before `enabled`), null when the image can't be shown. */
function useImageSource(output: ChatOutput, mount: number, enabled: boolean): string | null | undefined {
	const [state, setState] = useState<{ key: string; src: string | null } | null>(null);
	const key = `${mount}|${output.key}@${output.time}`;
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		void cachedImage(output, mount).then(src => live && setState({ key, src }));
		return () => {
			live = false;
		};
	}, [output, mount, enabled, key]);
	return state?.key === key ? state.src : undefined;
}

/** Becomes true once the element scrolls near view, so a long grid only reads the thumbnails on screen. */
function useNearView<T extends Element>(): [RefObject<T | null>, boolean] {
	const ref = useRef<T>(null);
	const [seen, setSeen] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (seen || !element) return;
		const observer = new IntersectionObserver(entries => entries.some(entry => entry.isIntersecting) && setSeen(true), { rootMargin: "200px" });
		observer.observe(element);
		return () => observer.disconnect();
	}, [seen]);
	return [ref, seen];
}

/** `alt` is empty where the surrounding button already names the image; `explain` shows the failure as text. */
function OutputImage({
	output,
	mount,
	enabled,
	alt,
	explain = false,
	className,
}: { output: ChatOutput; mount: number; enabled: boolean; alt: string; explain?: boolean; className?: string }) {
	const { t } = useTranslation("panes");
	const src = useImageSource(output, mount, enabled);
	const [broken, setBroken] = useState<string | null>(null);
	if (src === undefined) return <span className="sr-only">{t("outputs.loading")}</span>;
	if (src === null || broken === src) {
		return (
			<span className="flex flex-col items-center gap-2 text-center text-fg-faint">
				<ImageBroken aria-hidden className="size-5" />
				<span className={explain ? "text-sm text-fg-muted" : "sr-only"}>{t("outputs.unavailable")}</span>
			</span>
		);
	}
	return <img src={src} alt={alt} onError={() => setBroken(src)} className={className} />;
}

// ── actions ─────────────────────────────────────────────────────────────────────────────────────

function revealLabel(t: (key: string) => string): string {
	return t(window.vomp.platform === "darwin" ? "files.revealMac" : "files.reveal");
}

function copyPath(path: string, t: (key: string) => string): void {
	void navigator.clipboard.writeText(path);
	toast({ tone: "ok", message: t("files.copied") });
}

function openWithDefaultApp(path: string, t: (key: string) => string): void {
	window.vomp.invoke("panes:openImage", path).catch((error: unknown) => toast({ tone: "err", message: t("outputs.openFailed"), description: errorText(error) }));
}

/** A file opens in the Files pane, which needs the chat's project; without one it is shown in its folder. */
function openFile(path: string, projectPath: string | null): void {
	if (projectPath) openInFiles(projectPath, path);
	else void window.vomp.invoke("app:showItem", path);
}

/** Right-click menu for an output with a path; outputs without one have no file actions. */
function OutputMenu({ output, projectPath, children }: { output: ChatOutput; projectPath: string | null; children: ReactNode }) {
	const { t } = useTranslation("panes");
	const path = output.path;
	if (!path) return children;
	// Main opens only raster images externally; anything else (SVG included) opens in the Files pane.
	const image = output.kind === "image" && RASTER_EXT.test(path);
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				{image ? (
					<ContextMenuItem icon={<ArrowSquareOut />} onSelect={() => openWithDefaultApp(path, t)}>
						{t("outputs.openDefault")}
					</ContextMenuItem>
				) : (
					<ContextMenuItem icon={<FileIcon />} onSelect={() => openFile(path, projectPath)}>
						{t("files.open")}
					</ContextMenuItem>
				)}
				<ContextMenuSeparator />
				<ContextMenuItem icon={<Copy />} onSelect={() => copyPath(path, t)}>
					{t("files.copyPath")}
				</ContextMenuItem>
				<ContextMenuItem icon={<FolderSimpleDashed />} onSelect={() => void window.vomp.invoke("app:showItem", path)}>
					{revealLabel(t)}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

// ── list ────────────────────────────────────────────────────────────────────────────────────────

function ImageTile({ output, mount, projectPath, onOpen }: { output: ChatOutput; mount: number; projectPath: string | null; onOpen(key: string): void }) {
	const { t } = useTranslation("panes");
	const name = useOutputName(output);
	const [ref, near] = useNearView<HTMLButtonElement>();
	return (
		<motion.li layout="position" {...listRowMotion}>
			<OutputMenu output={output} projectPath={projectPath}>
				<button
					ref={ref}
					type="button"
					data-output={output.key}
					onClick={() => onOpen(output.key)}
					aria-label={t("outputs.openImage", { name })}
					title={output.path ?? name}
					className={cn("flex w-full flex-col gap-1.5 rounded-md p-1 text-left hover:bg-hover", focusRingInset)}
				>
					<span className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-sm border border-border bg-inset">
						<OutputImage output={output} mount={mount} enabled={near} alt="" className="size-full object-contain" />
					</span>
					<span className="truncate px-0.5 text-xs text-fg-muted">{name}</span>
				</button>
			</OutputMenu>
		</motion.li>
	);
}

function FileRow({ output, projectPath }: { output: ChatOutput; projectPath: string | null }) {
	const path = output.path ?? "";
	const name = baseName(path);
	const folder = path.slice(0, path.length - name.length - 1);
	const when = useWhen(output);
	const Icon = languageFor(name) ? FileCode : FileIcon;
	return (
		<motion.li layout="position" {...listRowMotion}>
			<OutputMenu output={output} projectPath={projectPath}>
				<button
					type="button"
					data-output={output.key}
					onClick={() => openFile(path, projectPath)}
					title={path}
					className={cn("flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-hover", focusRingInset)}
				>
					<Icon aria-hidden className="size-4 shrink-0 text-fg-faint" />
					{/* The folder takes only leftover space, so it ellipsizes first and the name shrinks after it. */}
					<span className="min-w-0 truncate text-fg">{name}</span>
					<span className="min-w-0 flex-1 truncate text-xs text-fg-faint">{projectPath ? relativePath(projectPath, folder) : folder}</span>
					<span className="shrink-0 text-xs whitespace-nowrap text-fg-faint">{when}</span>
				</button>
			</OutputMenu>
		</motion.li>
	);
}

function OutputList({
	outputs,
	mount,
	projectPath,
	restoreKey,
	onOpen,
}: {
	outputs: ChatOutput[];
	mount: number;
	projectPath: string | null;
	restoreKey: string | null;
	onOpen(key: string): void;
}) {
	const { t } = useTranslation("panes");
	const listRef = useRef<HTMLDivElement>(null);
	const images = outputs.filter(output => output.kind === "image");
	const files = outputs.filter(output => output.kind === "file");
	// Back from the viewer: focus returns to the tile that opened it.
	useEffect(() => {
		if (!restoreKey) return;
		for (const element of listRef.current?.querySelectorAll<HTMLElement>("[data-output]") ?? []) {
			if (element.dataset.output === restoreKey) element.focus();
		}
	}, [restoreKey]);
	return (
		<div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
			{images.length > 0 && (
				<Section title={t("outputs.images")} count={<span className="text-xs font-normal text-fg-faint tabular-nums">{images.length}</span>}>
					<ul className="-mx-1 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1">
						<AnimatePresence initial={false}>
							{images.map(output => (
								<ImageTile key={output.key} output={output} mount={mount} projectPath={projectPath} onOpen={onOpen} />
							))}
						</AnimatePresence>
					</ul>
				</Section>
			)}
			{files.length > 0 && (
				<Section title={t("outputs.files")} count={<span className="text-xs font-normal text-fg-faint tabular-nums">{files.length}</span>}>
					<ul className="-mx-2 space-y-px">
						<AnimatePresence initial={false}>
							{files.map(output => (
								<FileRow key={output.key} output={output} projectPath={projectPath} />
							))}
						</AnimatePresence>
					</ul>
				</Section>
			)}
		</div>
	);
}

// ── viewer ──────────────────────────────────────────────────────────────────────────────────────

function ImageViewer({ output, mount, projectPath, onBack }: { output: ChatOutput; mount: number; projectPath: string | null; onBack(): void }) {
	const { t } = useTranslation("panes");
	const name = useOutputName(output);
	const when = useWhen(output);
	const rootRef = useRef<HTMLDivElement>(null);
	const path = output.path;
	const openable = path !== null && RASTER_EXT.test(path);
	useEffect(() => {
		rootRef.current?.querySelector<HTMLElement>("button")?.focus();
	}, []);
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		event.preventDefault();
		event.stopPropagation();
		onBack();
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Escape anywhere in the viewer goes back to the list
		<div ref={rootRef} className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
			<PaneToolbar>
				<IconButton size="sm" label={t("outputs.back")} shortcut="Esc" icon={<ArrowLeft />} onClick={onBack} />
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted" title={path ?? name}>
					{name}
				</span>
				{path && (
					<>
						{openable && <IconButton size="sm" label={t("outputs.openDefault")} icon={<ArrowSquareOut />} onClick={() => openWithDefaultApp(path, t)} />}
						<IconButton size="sm" label={revealLabel(t)} icon={<FolderSimpleDashed />} onClick={() => void window.vomp.invoke("app:showItem", path)} />
						<IconButton size="sm" label={t("files.copyPath")} icon={<Copy />} onClick={() => copyPath(path, t)} />
					</>
				)}
			</PaneToolbar>
			<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-inset p-4">
				<OutputImage output={output} mount={mount} enabled explain alt={name} className="max-h-full max-w-full rounded-md border border-border object-contain" />
			</div>
			<p className="flex gap-2 border-t border-border px-3 py-1.5 text-xs text-fg-faint">
				<span className="shrink-0">{when}</span>
				{path && (
					<span className="min-w-0 flex-1 truncate font-mono" title={path}>
						{projectPath ? relativePath(projectPath, path) : path}
					</span>
				)}
			</p>
		</div>
	);
}

// ── pane ────────────────────────────────────────────────────────────────────────────────────────

export function OutputsPane({ session, projectPath }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const outputs = useChatOutputs(session, view);
	const [mount] = useState(() => ++paneMounts);
	const tabId = session?.tabId ?? null;
	const [opened, setOpened] = useState<{ tabId: string | null; key: string } | null>(null);
	const [restoreKey, setRestoreKey] = useState<string | null>(null);
	const selected = opened?.tabId === tabId ? (outputs?.find(output => output.key === opened.key) ?? null) : null;
	const project = projectPath ?? session?.projectPath ?? null;

	if (!session) return <EmptyState icon={<Images />} title={t("outputs.noChatTitle")} body={t("outputs.noChat")} />;
	const swapKey = selected ? `view:${selected.key}` : outputs && outputs.length > 0 ? "list" : "empty";
	return (
		<PresenceSwap swapKey={swapKey} className="flex min-h-0 flex-1 flex-col">
			{selected ? (
				<ImageViewer
					output={selected}
					mount={mount}
					projectPath={project}
					onBack={() => {
						setRestoreKey(selected.key);
						setOpened(null);
					}}
				/>
			) : outputs && outputs.length > 0 ? (
				<OutputList
					outputs={outputs}
					mount={mount}
					projectPath={project}
					restoreKey={restoreKey}
					onOpen={key => {
						setRestoreKey(null);
						setOpened({ tabId, key });
					}}
				/>
			) : (
				<EmptyState icon={<Images />} title={t("outputs.emptyTitle")} body={t("outputs.empty")} />
			)}
		</PresenceSwap>
	);
}

/** Newest output time each chat's Outputs pane has shown, by tab; the first value is the newest output when the tab badge first saw the chat. */
const useOutputsSeen = create<Record<string, number>>(() => ({}));

/** Tab badge: how many outputs arrived (or were made again) since the pane last showed this chat. */
export function OutputsBadge({ session }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const outputs = useChatOutputs(session, view);
	const visible = usePaneVisible("outputs");
	const tabId = session?.tabId ?? null;
	const seen = useOutputsSeen(state => (tabId ? state[tabId] : undefined));
	const newest = outputs?.reduce((max, output) => Math.max(max, output.time), 0) ?? 0;
	useEffect(() => {
		if (tabId && outputs && seen !== newest && (visible || seen === undefined)) useOutputsSeen.setState({ [tabId]: newest });
	}, [tabId, outputs, seen, newest, visible]);
	const count = outputs && seen !== undefined && !visible ? outputs.filter(output => output.time > seen).length : 0;
	return count > 0 ? <Badge count={count} label={t("outputs.newCount", { count })} /> : null;
}
