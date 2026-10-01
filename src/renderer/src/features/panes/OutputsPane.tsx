/**
 * Outputs pane (DESIGN §3.7): the images, PDFs and files omp made or showed in the focused chat, newest first.
 * Besides the files tools name as outputs, main checks the paths each command named for files modified while it ran
 * (best effort). Images load from disk when they have a path, so a re-rendered file shows its current state; images
 * without a file fall back to the data in the tool result (or omp's blob store for saved chats). PDFs show the
 * operating system's thumbnail when it provides one and open in Chromium's PDF viewer inside the pane. Clicking a
 * file opens it in the Files pane.
 */
import type { PaneMadeFile } from "@shared/contracts/panes";
import { ArrowLeft, ArrowSquareOut, Copy, FileCode, FileIcon, FolderSimpleDashed, Images } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { PaneProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { activeBranch, type SavedParents, savedParents } from "../../state/history";
import { liveEntries, type SessionController, type SessionView } from "../../state/session";
import { Badge, cn, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, EmptyState, IconButton, PresenceSwap, toast } from "../../ui";
import { focusRingInset } from "../../ui/styles";
import { useHomeDir } from "../projects/folders/FolderBrowser";
import { listRowMotion, PaneToolbar, relativePath, Section, SectionCount, usePaneVisible } from "./common";
import { type ChatOutput, chatOutputs, IMAGE_EXT, isIntactBase64, type MadeCandidate, type MadeFiles, madeCandidates, OPENABLE_EXT } from "./derive";
import { openInFiles } from "./FilesPane";
import { languageFor } from "./highlight";
import { ExpandPreview, loadFileImage, openWithDefaultApp, PdfFrame, PreviewImage, revealLabel, ThumbnailFrame, useNearView } from "./media";

// ── files made by commands ──────────────────────────────────────────────────────────────────────

/** Files main found that each tool call made, by call id. */
const useMade = create<Record<string, readonly PaneMadeFile[]>>(() => ({}));
/**
 * Outputs pane mounts so far. It also numbers the scans: reopening the pane checks every call again (files that are
 * gone drop out), and its image cache starts over.
 */
let paneMounts = 0;
/** `<mount>@<window end>` each call was last checked at; a background job whose result arrived is checked again. */
const scanned = new Map<string, string>();
const SCAN_BATCH = 64;
/** The scan queue: one batch in flight at a time across every chat, so main's per-request limits bound the total work. */
let scanQueue: Promise<void> = Promise.resolve();

async function scanBatch(batch: readonly MadeCandidate[]): Promise<void> {
	const results = await window.vomp.invoke("panes:scanMade", batch.map(({ paths, start, end }) => ({ paths, start, end })));
	const files = { ...useMade.getState() };
	batch.forEach((candidate, n) => {
		const found = results[n] ?? [];
		if (found.length > 0) files[candidate.id] = found;
		else delete files[candidate.id];
	});
	// Replace, so calls whose files are gone lose their entry.
	useMade.setState(files, true);
}

function requestScan(candidates: readonly MadeCandidate[], generation: number): void {
	const due = candidates.filter(candidate => scanned.get(candidate.id) !== `${generation}@${candidate.end}`);
	for (const candidate of due) scanned.set(candidate.id, `${generation}@${candidate.end}`);
	for (let i = 0; i < due.length; i += SCAN_BATCH) {
		const batch = due.slice(i, i + SCAN_BATCH);
		// A failed scan leaves the call without made files; the next reopen tries again.
		scanQueue = scanQueue.then(() => scanBatch(batch)).catch(() => {});
	}
}

// ── outputs of the focused chat ─────────────────────────────────────────────────────────────────

interface Branch {
	leaf: string | null;
	saved: SavedParents | undefined;
	cwd: string | null;
	home: string | null;
	entries: readonly SessionEntry[];
	candidates: MadeCandidate[];
}

interface Derived {
	made: MadeFiles;
	outputs: ChatOutput[];
	/** Newest result time the outputs could come from, including calls whose made files are still being checked. */
	latest: number;
}

/** Keyed by the session's entry list (then the branch), so the pane and its tab badge share one derivation per update. */
const branches = new WeakMap<readonly SessionEntry[], Branch>();
const derived = new WeakMap<Branch, Derived>();

/**
 * The chat's outputs from the entries the transcript shows: the live stream's active branch, else the saved
 * history, plus the files main found that its commands made. Null until either has loaded.
 */
function useChatOutputs(session: SessionController | null, view: SessionView | null): Derived | null {
	const home = useHomeDir();
	const liveSource = liveEntries(view);
	const live = liveSource !== null;
	const source = liveSource ?? view?.history?.entries ?? null;
	const leaf = live ? (view?.displayLeaf ?? null) : null;
	const saved = live ? savedParents(view?.history) : undefined;
	const cwd = view?.history?.header?.cwd ?? session?.projectPath ?? null;
	const branch = useMemo(() => {
		if (!source) return null;
		const cached = branches.get(source);
		if (cached && cached.leaf === leaf && cached.saved === saved && cached.cwd === cwd && cached.home === home) return cached;
		const entries = live ? activeBranch(source, leaf, saved) : source;
		const next: Branch = { leaf, saved, cwd, home, entries, candidates: madeCandidates(entries, { cwd, home }) };
		branches.set(source, next);
		return next;
	}, [source, live, leaf, saved, cwd, home]);
	const made = useMade();
	// Read during render: the pane counts its mount before this hook runs, so its first scan already uses it.
	const generation = paneMounts;
	useEffect(() => {
		if (branch) requestScan(branch.candidates, generation);
	}, [branch, generation]);
	return useMemo(() => {
		if (!branch) return null;
		const cached = derived.get(branch);
		if (cached && cached.made === made) return cached;
		const outputs = chatOutputs(branch.entries, { cwd: branch.cwd, home: branch.home }, made);
		let latest = 0;
		for (const candidate of branch.candidates) latest = Math.max(latest, candidate.end);
		for (const output of outputs) latest = Math.max(latest, output.time);
		const next = { made, outputs, latest };
		derived.set(branch, next);
		return next;
	}, [branch, made]);
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
	return t(`outputs.when.${output.action}`, { time: formatTime(output.time) });
}

/** Main opens (and thumbnails) only raster images and PDFs whose bytes match; SVG stays in the app. */
function isOpenable(output: ChatOutput): output is ChatOutput & { path: string } {
	return output.kind !== "file" && output.path !== null && OPENABLE_EXT.test(output.path);
}

// ── image loading ───────────────────────────────────────────────────────────────────────────────

/**
 * A PDF's thumbnail from the operating system (null when it makes none); for an image, the file on disk first (its
 * current version), then intact inline data, then omp's blob store. Null when none works.
 */
async function loadImage(output: ChatOutput): Promise<string | null> {
	if (output.kind === "pdf") return output.path ? window.vomp.invoke("panes:thumbnail", output.path).catch(() => null) : null;
	if (output.path && IMAGE_EXT.test(output.path)) {
		const file = await loadFileImage(output.path);
		if (file) return file;
	}
	const inline = output.inline;
	if (inline?.kind === "data") return isIntactBase64(inline.data) ? `data:${inline.mimeType};base64,${inline.data}` : null;
	if (inline?.kind === "blob") return window.vomp.invoke("panes:readBlob", inline.hash).catch(() => null);
	return null;
}

/**
 * Read once per `<pane mount>|<key>@<time>`: a reopened pane, or a newer use of the same file, reads it again.
 * `alt` is empty where the surrounding button already names the image; `explain` shows the failure as text.
 */
function OutputImage({
	output,
	mount,
	enabled,
	alt,
	explain = false,
	className,
}: { output: ChatOutput; mount: number; enabled: boolean; alt: string; explain?: boolean; className?: string }) {
	return (
		<PreviewImage
			sourceKey={`${mount}|${output.key}@${output.time}`}
			load={() => loadImage(output)}
			pdf={output.kind === "pdf"}
			enabled={enabled}
			alt={alt}
			explain={explain}
			className={className}
		/>
	);
}

// ── actions ─────────────────────────────────────────────────────────────────────────────────────

function copyPath(path: string, t: (key: string) => string): void {
	void navigator.clipboard.writeText(path);
	toast({ tone: "ok", message: t("files.copied") });
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
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				{isOpenable(output) ? (
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

function PreviewTile({ output, mount, projectPath, onOpen }: { output: ChatOutput; mount: number; projectPath: string | null; onOpen(key: string): void }) {
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
					<ThumbnailFrame pdf={output.kind === "pdf"}>
						<OutputImage output={output} mount={mount} enabled={near} alt="" className="size-full object-contain" />
					</ThumbnailFrame>
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

/** Viewed images and PDFs shown before "Show N more". */
const VIEWED_LIMIT = 12;

function PreviewGrid({ outputs, mount, projectPath, onOpen }: { outputs: ChatOutput[]; mount: number; projectPath: string | null; onOpen(key: string): void }) {
	return (
		<ul className="-mx-1 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1">
			<AnimatePresence initial={false}>
				{outputs.map(output => (
					<PreviewTile key={output.key} output={output} mount={mount} projectPath={projectPath} onOpen={onOpen} />
				))}
			</AnimatePresence>
		</ul>
	);
}

/**
 * Three sections by what omp did: images and PDFs it made (deliverables), other files it made, and images and PDFs it
 * only looked at, which are capped so a long run of review renders doesn't bury the deliverables.
 */
function OutputList({
	outputs,
	mount,
	projectPath,
	restoreKey,
	showAllViewed,
	onShowAllViewed,
	onOpen,
}: {
	outputs: ChatOutput[];
	mount: number;
	projectPath: string | null;
	restoreKey: string | null;
	showAllViewed: boolean;
	onShowAllViewed(): void;
	onOpen(key: string): void;
}) {
	const { t } = useTranslation("panes");
	const listRef = useRef<HTMLDivElement>(null);
	const made = outputs.filter(output => output.kind !== "file" && output.produced);
	const files = outputs.filter(output => output.kind === "file");
	const viewed = outputs.filter(output => output.kind !== "file" && !output.produced);
	const shownViewed = showAllViewed ? viewed : viewed.slice(0, VIEWED_LIMIT);
	// Back from the viewer: focus returns to the tile that opened it.
	useEffect(() => {
		if (!restoreKey) return;
		for (const element of listRef.current?.querySelectorAll<HTMLElement>("[data-output]") ?? []) {
			if (element.dataset.output === restoreKey) element.focus();
		}
	}, [restoreKey]);
	return (
		<div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
			{made.length > 0 && (
				<Section title={t("outputs.made")} count={<SectionCount count={made.length} />}>
					<PreviewGrid outputs={made} mount={mount} projectPath={projectPath} onOpen={onOpen} />
				</Section>
			)}
			{files.length > 0 && (
				<Section title={t("outputs.files")} count={<SectionCount count={files.length} />}>
					<ul className="-mx-2 space-y-px">
						<AnimatePresence initial={false}>
							{files.map(output => (
								<FileRow key={output.key} output={output} projectPath={projectPath} />
							))}
						</AnimatePresence>
					</ul>
				</Section>
			)}
			{viewed.length > 0 && (
				<Section title={t("outputs.viewed")} count={<SectionCount count={viewed.length} />}>
					<PreviewGrid outputs={shownViewed} mount={mount} projectPath={projectPath} onOpen={onOpen} />
					{shownViewed.length < viewed.length && (
						<button
							type="button"
							onClick={onShowAllViewed}
							className={cn("mt-1 h-7 rounded-md px-1 text-left text-sm text-fg-muted hover:bg-hover hover:text-fg", focusRingInset)}
						>
							{t("outputs.moreViewed", { count: viewed.length - shownViewed.length })}
						</button>
					)}
				</Section>
			)}
		</div>
	);
}

// ── viewer ──────────────────────────────────────────────────────────────────────────────────────

function OutputViewer({ output, mount, projectPath, onBack }: { output: ChatOutput; mount: number; projectPath: string | null; onBack(): void }) {
	const { t } = useTranslation("panes");
	const name = useOutputName(output);
	const when = useWhen(output);
	const rootRef = useRef<HTMLDivElement>(null);
	const path = output.path;
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
				<ExpandPreview
					name={name}
					path={path}
					image={output.kind !== "pdf" || !path}
					render={className =>
						output.kind === "pdf" && path ? (
							<PdfFrame path={path} revision={output.time} name={name} />
						) : (
							<OutputImage output={output} mount={mount} enabled explain alt={name} className={className} />
						)
					}
				/>
				{path && (
					<>
						{isOpenable(output) && <IconButton size="sm" label={t("outputs.openDefault")} icon={<ArrowSquareOut />} onClick={() => openWithDefaultApp(path, t)} />}
						<IconButton size="sm" label={revealLabel(t)} icon={<FolderSimpleDashed />} onClick={() => void window.vomp.invoke("app:showItem", path)} />
						<IconButton size="sm" label={t("files.copyPath")} icon={<Copy />} onClick={() => copyPath(path, t)} />
					</>
				)}
			</PaneToolbar>
			{output.kind === "pdf" && path ? (
				<div className="flex min-h-0 flex-1 flex-col bg-inset">
					<PdfFrame path={path} revision={output.time} name={name} />
				</div>
			) : (
				<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-inset p-4">
					<OutputImage output={output} mount={mount} enabled explain alt={name} className="max-h-full max-w-full rounded-md border border-border object-contain" />
				</div>
			)}
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
	// Counted before the outputs hook runs, so this mount's scan and image cache are fresh.
	const [mount] = useState(() => ++paneMounts);
	const outputs = useChatOutputs(session, view)?.outputs ?? null;
	const tabId = session?.tabId ?? null;
	const [opened, setOpened] = useState<{ tabId: string | null; key: string } | null>(null);
	const [restoreKey, setRestoreKey] = useState<string | null>(null);
	// Kept here, so opening a tile past the first 12 and coming back keeps it on screen.
	const [showAllViewed, setShowAllViewed] = useState(false);
	const selected = opened?.tabId === tabId ? (outputs?.find(output => output.key === opened.key) ?? null) : null;
	const project = projectPath ?? session?.projectPath ?? null;

	if (!session) return <EmptyState icon={<Images />} title={t("outputs.noChatTitle")} body={t("outputs.noChat")} />;
	const swapKey = selected ? `view:${selected.key}` : outputs && outputs.length > 0 ? "list" : "empty";
	return (
		<PresenceSwap swapKey={swapKey} className="flex min-h-0 flex-1 flex-col">
			{selected ? (
				<OutputViewer
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
					showAllViewed={showAllViewed}
					onShowAllViewed={() => setShowAllViewed(true)}
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

/** Newest output time each chat's Outputs pane has shown, by tab; the first value is the chat's newest result when the tab badge first saw it. */
const useOutputsSeen = create<Record<string, number>>(() => ({}));

/** Tab badge: how many outputs arrived (or were made again) since the pane last showed this chat. */
export function OutputsBadge({ session }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const chat = useChatOutputs(session, view);
	const visible = usePaneVisible("outputs");
	const tabId = session?.tabId ?? null;
	const seen = useOutputsSeen(state => (tabId ? state[tabId] : undefined));
	// `latest` covers calls whose made files arrive after this first look, so they aren't counted as new.
	const newest = chat?.latest ?? 0;
	useEffect(() => {
		if (tabId && chat && seen !== newest && (visible || seen === undefined)) useOutputsSeen.setState({ [tabId]: newest });
	}, [tabId, chat, seen, newest, visible]);
	const count = chat && seen !== undefined && !visible ? chat.outputs.filter(output => output.time > seen).length : 0;
	return count > 0 ? <Badge count={count} label={t("outputs.newCount", { count })} /> : null;
}
