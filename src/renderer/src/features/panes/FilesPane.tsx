/**
 * Files pane (DESIGN §3.7): a lazy project tree (24px rows, 12px indent steps) and viewer tabs with
 * syntax colors, inline images, PDFs and folder listings. A tab can show any path, inside the project
 * or not. ⌘click or right-click → "Mention in chat" puts `@path` in the composer of the focused chat.
 */
import { ArrowSquareOut, ArrowsClockwise, At, CaretRight, Copy, FileCode, FileIcon, FileImage, Folder, FolderOpen, FolderSimpleDashed, SidebarSimple } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type MouseEvent, memo, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { PaneFileContent } from "@shared/contracts/panes";
import type { DirEntry } from "@shared/ipc";
import { useComposerDrafts } from "../../chat/composer/drafts";
import type { PaneProps } from "../../registry/slots";
import { useApp } from "../../state/app";
import {
	Button,
	cn,
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
	duration,
	EmptyState,
	ease,
	Expand,
	IconButton,
	PresenceSwap,
	Spinner,
	spring,
	toast,
} from "../../ui";
import { focusRingInset } from "../../ui/styles";
import { errorText } from "../extensions/format";
import { useHomeDir } from "../projects/folders/FolderBrowser";
import { tildePath } from "../projects/folders/paths";
import { PaneToolbar, relativePath, Section, SectionCount, TabStrip, usePaneVisible } from "./common";
import { IMAGE_EXT, OPENABLE_EXT, PDF_EXT } from "./derive";
import { useGit } from "./git-store";
import { languageFor, SYN_CLASS, tokenizeLines } from "./highlight";
import { ExpandPreview, loadFileImage, openWithDefaultApp, PdfFrame, PreviewImage, revealLabel, ThumbnailFrame, useNearView } from "./media";

const HIDDEN: Record<string, true> = { ".git": true, node_modules: true };
/** Lines rendered before "Show all" in the viewer. */
const VIEW_LINE_BUDGET = 4000;
/** Folder entries a folder tab lists before "Show all". */
const FOLDER_LIMIT = 200;

// ── per-project state (survives pane switches) ──────────────────────────────────────────────────

interface ProjectFiles {
	expanded: string[];
	tabs: string[];
	active: string | null;
	/** The tree is hidden so the viewer takes the pane's width (only while tabs are open). */
	treeHidden: boolean;
}

interface FilesState {
	byProject: Record<string, ProjectFiles>;
	children: Record<string, DirEntry[] | "error">;
	toggle(project: string, dir: string, open?: boolean): void;
	open(project: string, path: string): void;
	close(project: string, path: string): void;
	activate(project: string, path: string): void;
	setTreeHidden(project: string, hidden: boolean): void;
	load(dir: string): Promise<void>;
}

const EMPTY_PROJECT: ProjectFiles = { expanded: [], tabs: [], active: null, treeHidden: false };

const useFiles = create<FilesState>((set, get) => {
	const patch = (project: string, change: (current: ProjectFiles) => ProjectFiles) =>
		set(state => ({ byProject: { ...state.byProject, [project]: change(state.byProject[project] ?? EMPTY_PROJECT) } }));
	return {
		byProject: {},
		children: {},
		toggle(project, dir, open) {
			patch(project, current => {
				const isOpen = current.expanded.includes(dir);
				const next = open ?? !isOpen;
				if (next === isOpen) return current;
				return { ...current, expanded: next ? [...current.expanded, dir] : current.expanded.filter(entry => entry !== dir) };
			});
			if (open !== false && !get().children[dir]) void get().load(dir);
		},
		open(project, path) {
			patch(project, current => ({ ...current, tabs: current.tabs.includes(path) ? current.tabs : [...current.tabs, path], active: path }));
		},
		close(project, path) {
			patch(project, current => {
				const index = current.tabs.indexOf(path);
				const tabs = current.tabs.filter(entry => entry !== path);
				const active = current.active === path ? (tabs[index] ?? tabs[index - 1] ?? null) : current.active;
				// With no tab left the tree fills the pane again, so it comes back for the next file opened from it.
				return { ...current, tabs, active, treeHidden: tabs.length > 0 && current.treeHidden };
			});
		},
		activate(project, path) {
			patch(project, current => ({ ...current, active: path }));
		},
		setTreeHidden(project, hidden) {
			patch(project, current => (current.treeHidden === hidden ? current : { ...current, treeHidden: hidden }));
		},
		async load(dir) {
			try {
				const entries = await window.vomp.invoke("fs:list", dir);
				set(state => ({ children: { ...state.children, [dir]: entries.filter(entry => !Object.hasOwn(HIDDEN, entry.name)) } }));
			} catch {
				set(state => ({ children: { ...state.children, [dir]: "error" } }));
			}
		},
	};
});

/**
 * Open a file or folder as a viewer tab in the Files pane (tool cards' "Open in Files", file links in
 * replies). Any absolute path works, inside the project or not; a trailing separator is dropped so
 * `dir/` and `dir` share one tab. `focus` hides the project's tree so the viewer takes the pane's
 * width; without it the tree stays as the user left it.
 */
export function openInFiles(projectPath: string, path: string, options?: { focus?: boolean }): void {
	const files = useFiles.getState();
	files.open(projectPath, path.replace(/(?<=[^\\/:])[\\/]+$/, ""));
	if (options?.focus) files.setTreeHidden(projectPath, true);
	useApp.getState().showPane("files");
}

/** The viewer's path label: project-relative inside the project, else `~/…` under the home folder, else absolute. */
function viewerPath(projectPath: string, path: string, home: string | null): string {
	const rel = relativePath(projectPath, path);
	return rel === path ? tildePath(path, home) : rel;
}

/** The last path segment, for `/` and `\` paths alike. */
function fileName(path: string): string {
	return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || path;
}

/** Put `@relative/path` into the focused chat's composer (a new chat when none is open). */
export function mentionInChat(projectPath: string, path: string, tabId: string | null): void {
	const target = tabId ?? useApp.getState().newChat(projectPath);
	if (!target) return;
	const rel = relativePath(projectPath, path);
	useComposerDrafts.getState().insert(target, `@${rel} `);
}

// ── tree ────────────────────────────────────────────────────────────────────────────────────────

interface RowProps {
	entry: DirEntry;
	depth: number;
	projectPath: string;
	tabId: string | null;
}

function FileMenu({ entry, projectPath, tabId, children }: RowProps & { children: ReactNode }) {
	const { t } = useTranslation("panes");
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem icon={<At />} onSelect={() => mentionInChat(projectPath, entry.path, tabId)} shortcut="⌘click">
					{t("files.mention")}
				</ContextMenuItem>
				{entry.kind === "file" && (
					<ContextMenuItem icon={<FileIcon />} onSelect={() => useFiles.getState().open(projectPath, entry.path)}>
						{t("files.open")}
					</ContextMenuItem>
				)}
				<ContextMenuSeparator />
				<ContextMenuItem
					icon={<Copy />}
					onSelect={() => {
						void navigator.clipboard.writeText(relativePath(projectPath, entry.path));
						toast({ tone: "ok", message: t("files.copied") });
					}}
				>
					{t("files.copyPath")}
				</ContextMenuItem>
				<ContextMenuItem icon={<FolderSimpleDashed />} onSelect={() => void window.vomp.invoke("app:showItem", entry.path)}>
					{revealLabel(t)}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

const TreeRow = memo(function TreeRow({ entry, depth, projectPath, tabId }: RowProps) {
	const { t } = useTranslation("panes");
	const expanded = useFiles(state => (state.byProject[projectPath] ?? EMPTY_PROJECT).expanded.includes(entry.path));
	const active = useFiles(state => state.byProject[projectPath]?.active === entry.path);
	const children = useFiles(state => state.children[entry.path]);
	const isDir = entry.kind === "dir";
	const onClick = (event: MouseEvent) => {
		if (event.metaKey || event.ctrlKey) {
			mentionInChat(projectPath, entry.path, tabId);
			return;
		}
		if (isDir) useFiles.getState().toggle(projectPath, entry.path);
		else useFiles.getState().open(projectPath, entry.path);
	};
	const Icon = isDir ? (expanded ? FolderOpen : Folder) : IMAGE_EXT.test(entry.name) ? FileImage : languageFor(entry.name) ? FileCode : FileIcon;
	return (
		<li role="none">
			<FileMenu entry={entry} depth={depth} projectPath={projectPath} tabId={tabId}>
				<button
					type="button"
					role="treeitem"
					aria-expanded={isDir ? expanded : undefined}
					aria-selected={active}
					aria-level={depth + 1}
					data-path={entry.path}
					data-kind={entry.kind}
					tabIndex={-1}
					onClick={onClick}
					title={t("files.rowHint", { name: entry.name })}
					style={{ paddingLeft: 6 + depth * 12 }}
					className={cn(
						"flex h-6 w-full items-center gap-1 pr-2 text-left text-sm",
						active ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
						focusRingInset,
					)}
				>
					<span aria-hidden className="inline-flex size-3.5 shrink-0 items-center justify-center text-fg-faint">
						{isDir && (
							<CaretRight className={cn("size-3.5 transition-transform duration-(--dur) ease-(--ease-out-quart)", expanded && "rotate-90")} />
						)}
					</span>
					<Icon aria-hidden className={cn("size-3.5 shrink-0", isDir ? "text-accent" : "text-fg-faint")} />
					<span className="truncate">{entry.name}</span>
				</button>
			</FileMenu>
			{isDir && (
				<Expand open={expanded}>
					<ul role="group">
						{children === undefined ? (
							<li role="none" className="h-6 text-xs leading-6 text-fg-faint" style={{ paddingLeft: 30 + depth * 12 }}>
								{t("files.loading")}
							</li>
						) : children === "error" ? (
							<li role="none" className="h-6 text-xs leading-6 text-err" style={{ paddingLeft: 30 + depth * 12 }}>
								{t("files.cantOpen")}
							</li>
						) : children.length === 0 ? (
							<li role="none" className="h-6 text-xs leading-6 text-fg-faint" style={{ paddingLeft: 30 + depth * 12 }}>
								{t("files.emptyFolder")}
							</li>
						) : (
							children.map(child => <TreeRow key={child.path} entry={child} depth={depth + 1} projectPath={projectPath} tabId={tabId} />)
						)}
					</ul>
				</Expand>
			)}
		</li>
	);
});

/** Arrow-key navigation over the visible treeitems (WAI-ARIA tree pattern, roving focus). */
function onTreeKeyDown(event: KeyboardEvent<HTMLUListElement>, projectPath: string): void {
	const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
	const current = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="treeitem"]') : null;
	const index = current ? items.indexOf(current) : -1;
	const focus = (item: HTMLElement | undefined) => {
		if (!item) return;
		event.preventDefault();
		for (const other of items) other.tabIndex = -1;
		item.tabIndex = 0;
		item.focus();
	};
	const path = current?.dataset.path;
	const isDir = current?.dataset.kind === "dir";
	const open = current?.getAttribute("aria-expanded") === "true";
	switch (event.key) {
		case "ArrowDown":
			focus(items[index + 1]);
			break;
		case "ArrowUp":
			focus(items[Math.max(0, index - 1)]);
			break;
		case "Home":
			focus(items[0]);
			break;
		case "End":
			focus(items[items.length - 1]);
			break;
		case "ArrowRight":
			if (path && isDir && !open) {
				event.preventDefault();
				useFiles.getState().toggle(projectPath, path, true);
			} else if (isDir) focus(items[index + 1]);
			break;
		case "ArrowLeft":
			if (path && isDir && open) {
				event.preventDefault();
				useFiles.getState().toggle(projectPath, path, false);
			} else {
				const parent = current?.parentElement?.parentElement?.closest("li")?.querySelector<HTMLElement>('[role="treeitem"]');
				focus(parent ?? undefined);
			}
			break;
	}
}

// ── viewer ──────────────────────────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const CodeView = memo(function CodeView({ path, text }: { path: string; text: string }) {
	const { t } = useTranslation("panes");
	const [showAll, setShowAll] = useState(false);
	const lines = useMemo(() => text.replace(/\r\n/g, "\n").split("\n"), [text]);
	const tokens = useMemo(
		() => tokenizeLines(showAll ? lines : lines.slice(0, VIEW_LINE_BUDGET), languageFor(path)),
		[lines, showAll, path],
	);
	const gutter = String(lines.length).length;
	return (
		<div className="min-h-full bg-inset py-2 font-mono text-[12px] leading-5">
			<pre className="m-0">
				<code>
					{tokens.map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: line numbers are the identity
						<div key={index} className="flex">
							<span aria-hidden className="shrink-0 select-none px-3 text-right text-fg-faint tabular-nums" style={{ width: `${gutter + 3}ch` }}>
								{index + 1}
							</span>
							<span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3">
								{line.map((token, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: static tokens
									<span key={i} className={SYN_CLASS[token.role]}>
										{token.text}
									</span>
								))}
								{"\n"}
							</span>
						</div>
					))}
				</code>
			</pre>
			{!showAll && lines.length > VIEW_LINE_BUDGET && (
				<div className="flex justify-center py-2 font-ui">
					<Button size="sm" variant="secondary" onClick={() => setShowAll(true)}>
						{t("files.showAll", { count: lines.length })}
					</Button>
				</div>
			)}
		</div>
	);
});

/** Folder tab mounts so far; part of each thumbnail's cache key. */
let folderViews = 0;

/** A folder tab: images and PDFs as a thumbnail grid, then the other entries as rows; each opens as another tab. */
function FolderView({ dir, projectPath, revision }: { dir: string; projectPath: string; revision: number }) {
	const { t } = useTranslation("panes");
	const entries = useFiles(state => state.children[dir]);
	const [showAll, setShowAll] = useState(false);
	// Each view of the folder reads its thumbnails again (and so does each reload), so they show the current files.
	const [view] = useState(() => ++folderViews);
	if (!Array.isArray(entries)) return null;
	if (entries.length === 0) return <EmptyState icon={<FolderOpen />} title={t("files.emptyFolder")} />;
	const shown = showAll ? entries : entries.slice(0, FOLDER_LIMIT);
	const isPreview = (entry: DirEntry) => entry.kind === "file" && (IMAGE_EXT.test(entry.name) || PDF_EXT.test(entry.name));
	const previews = shown.filter(isPreview);
	const others = shown.filter(entry => !isPreview(entry));
	const open = (entry: DirEntry) => useFiles.getState().open(projectPath, entry.path);
	return (
		<div className="min-h-full bg-panel">
			{previews.length > 0 && (
				<Section title={t("files.folderMedia")} count={<SectionCount count={previews.length} />}>
					<ul className="-mx-1 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1">
						{previews.map(entry => (
							<FolderTile key={entry.path} entry={entry} sourceKey={`files:${view}:${revision}|${entry.path}`} onOpen={() => open(entry)} />
						))}
					</ul>
				</Section>
			)}
			{others.length > 0 && (
				<Section title={t("files.folderItems")} count={<SectionCount count={others.length} />}>
					<ul className="-mx-2 space-y-px">
						{others.map(entry => {
							const Icon = entry.kind === "dir" ? Folder : languageFor(entry.name) ? FileCode : FileIcon;
							return (
								<li key={entry.path}>
									<button
										type="button"
										onClick={() => open(entry)}
										title={entry.name}
										className={cn("flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-hover", focusRingInset)}
									>
										<Icon aria-hidden className={cn("size-4 shrink-0", entry.kind === "dir" ? "text-accent" : "text-fg-faint")} />
										<span className="min-w-0 truncate text-fg">{entry.name}</span>
									</button>
								</li>
							);
						})}
					</ul>
				</Section>
			)}
			{shown.length < entries.length && (
				<div className="flex justify-center py-3">
					<Button size="sm" variant="secondary" onClick={() => setShowAll(true)}>
						{t("files.showAllItems", { count: entries.length })}
					</Button>
				</div>
			)}
		</div>
	);
}

function FolderTile({ entry, sourceKey, onOpen }: { entry: DirEntry; sourceKey: string; onOpen(): void }) {
	const { t } = useTranslation("panes");
	const [ref, near] = useNearView<HTMLButtonElement>();
	const pdf = PDF_EXT.test(entry.name);
	return (
		<li>
			<button
				ref={ref}
				type="button"
				onClick={onOpen}
				aria-label={t("files.openEntry", { name: entry.name })}
				title={entry.name}
				className={cn("flex w-full flex-col gap-1.5 rounded-md p-1 text-left hover:bg-hover", focusRingInset)}
			>
				<ThumbnailFrame pdf={pdf}>
					<PreviewImage sourceKey={sourceKey} load={() => loadFileImage(entry.path)} pdf={pdf} enabled={near} alt="" className="size-full object-contain" />
				</ThumbnailFrame>
				<span className="truncate px-0.5 text-xs text-fg-muted">{entry.name}</span>
			</button>
		</li>
	);
}

/** What a viewer tab shows: a file's content, or a folder whose listing is in the store. */
type Shown = PaneFileContent | { kind: "folder" };

function Viewer({ path, projectPath, home, version }: { path: string; projectPath: string; home: string | null; version: number }) {
	const { t } = useTranslation("panes");
	const [content, setContent] = useState<Shown | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	const listing = useFiles(state => state.children[path]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version`/`reload` are refetch triggers
	useEffect(() => {
		let cancelled = false;
		window.vomp
			.invoke("panes:readFile", path)
			.then(next => {
				if (cancelled) return;
				setContent(next);
				setError(null);
			})
			.catch(async (reason: unknown) => {
				// Not a readable file: list it as a folder, through the tree's loader so the same entries are skipped.
				await useFiles.getState().load(path);
				if (cancelled) return;
				if (Array.isArray(useFiles.getState().children[path])) {
					setContent({ kind: "folder" });
					setError(null);
				} else setError(errorText(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [path, version, reload]);

	const name = fileName(path);
	const folder = content?.kind === "folder";
	const file = content !== null && content.kind !== "folder";
	// A `.pdf` path goes to the PDF viewer once the probe above shows it is a file (a folder can be named `x.pdf`); the
	// viewer reads and checks the bytes itself. The probe stays cheap: main sniffs a PDF as binary or too large.
	const pdf = file && !error && PDF_EXT.test(path);
	// Inside the project the tree's menu has Show in folder; outside it, the viewer offers it.
	const outside = relativePath(projectPath, path) === path;
	const reveal = () => void window.vomp.invoke("app:showItem", path);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PaneToolbar>
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted" title={path}>
					{viewerPath(projectPath, path, home)}
				</span>
				{content && content.kind !== "folder" && <span className="text-xs text-fg-faint">{formatSize(content.size)}</span>}
				{folder && Array.isArray(listing) && <span className="text-xs text-fg-faint tabular-nums">{t("files.itemCount", { count: listing.length })}</span>}
				{pdf && <ExpandPreview name={name} path={path} image={false} render={() => <PdfFrame path={path} revision={version + reload} name={name} />} />}
				{content?.kind === "image" && (
					<ExpandPreview name={name} path={path} image render={className => <img src={content.dataUrl} alt={name} className={className} />} />
				)}
				{file && OPENABLE_EXT.test(path) && (
					<IconButton size="sm" label={t("outputs.openDefault")} icon={<ArrowSquareOut />} onClick={() => openWithDefaultApp(path, t)} />
				)}
				{file && outside && <IconButton size="sm" label={revealLabel(t)} icon={<FolderSimpleDashed />} onClick={reveal} />}
				{folder && (
					<IconButton
						size="sm"
						label={t(window.vomp.platform === "darwin" ? "files.revealFolderMac" : "files.revealFolder")}
						icon={<FolderSimpleDashed />}
						onClick={reveal}
					/>
				)}
				<IconButton size="sm" label={t(folder ? "files.reloadFolder" : "files.reload")} icon={<ArrowsClockwise />} onClick={() => setReload(reload + 1)} />
			</PaneToolbar>
			{pdf ? (
				<div className="flex min-h-0 flex-1 flex-col bg-inset">
					{/* Both triggers only grow, so their sum changes whenever either does. */}
					<PdfFrame path={path} revision={version + reload} name={name} />
				</div>
			) : (
				<div className="min-h-0 flex-1 overflow-auto">
					{error ? (
						<EmptyState icon={<FileIcon />} title={t("files.cantOpenTitle")} body={error} />
					) : !content ? (
						<div className="flex items-center justify-center gap-2 py-10 text-sm text-fg-muted" role="status">
							<Spinner /> {t("files.loading")}
						</div>
					) : content.kind === "folder" ? (
						<FolderView dir={path} projectPath={projectPath} revision={version + reload} />
					) : content.kind === "text" ? (
						<CodeView path={path} text={content.text} />
					) : content.kind === "image" ? (
						<div className="flex min-h-full items-center justify-center bg-inset p-4">
							<img src={content.dataUrl} alt={name} className="max-h-full max-w-full rounded-md border border-border object-contain" />
						</div>
					) : (
						<EmptyState
							icon={<FileIcon />}
							title={t(content.kind === "binary" ? "files.binaryTitle" : "files.tooLargeTitle")}
							body={t(content.kind === "binary" ? "files.binary" : "files.tooLarge", { size: formatSize(content.size) })}
							actions={
								<Button size="sm" variant="secondary" onClick={reveal}>
									{revealLabel(t)}
								</Button>
							}
						/>
					)}
				</div>
			)}
		</div>
	);
}

// ── pane ────────────────────────────────────────────────────────────────────────────────────────

export function FilesPane({ session, projectPath }: PaneProps) {
	const { t } = useTranslation("panes");
	if (!projectPath) return <EmptyState icon={<Folder />} title={t("files.noProjectTitle")} body={t("files.noProject")} />;
	return <FilesView projectPath={projectPath} tabId={session?.tabId ?? null} />;
}

function FilesView({ projectPath, tabId }: { projectPath: string; tabId: string | null }) {
	const { t } = useTranslation("panes");
	const state = useFiles(s => s.byProject[projectPath] ?? EMPTY_PROJECT);
	const roots = useFiles(s => s.children[projectPath]);
	const visible = usePaneVisible("files");
	const home = useHomeDir();
	const git = useGit(visible ? projectPath : null);
	const treeRef = useRef<HTMLUListElement>(null);
	const [treeWidth, setTreeWidth] = useState(180);

	useEffect(() => {
		if (visible && !useFiles.getState().children[projectPath]) void useFiles.getState().load(projectPath);
	}, [visible, projectPath]);

	// Refresh the loaded folders when files change on disk (git:changed covers edits by omp).
	useEffect(() => {
		if (git.version === 0) return;
		const { children, byProject, load } = useFiles.getState();
		const open = [projectPath, ...(byProject[projectPath]?.expanded ?? [])];
		for (const dir of open) if (children[dir]) void load(dir);
	}, [git.version, projectPath]);

	// Keep exactly one tree row in the tab order.
	useEffect(() => {
		const tree = treeRef.current;
		if (!tree || tree.querySelector('[role="treeitem"][tabindex="0"]')) return;
		const first = tree.querySelector<HTMLElement>('[role="treeitem"]');
		if (first) first.tabIndex = 0;
	});

	const startResize = useCallback(
		(event: ReactPointerEvent) => {
			const startX = event.clientX;
			const start = treeWidth;
			const move = (e: PointerEvent) => setTreeWidth(Math.min(360, Math.max(120, start + e.clientX - startX)));
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[treeWidth],
	);

	const tabs = state.tabs.map(path => ({ id: path, label: fileName(path), title: viewerPath(projectPath, path, home) }));
	const treeShown = !state.treeHidden || state.tabs.length === 0;
	return (
		<div className="relative flex min-h-0 flex-1">
			<AnimatePresence initial={false}>
				{treeShown && (
					<motion.div
						key="tree"
						initial={{ opacity: 0, x: -12 }}
						animate={{ opacity: 1, x: 0 }}
						exit={{ opacity: 0, x: -12, transition: { duration: duration.fast, ease: "easeIn" } }}
						transition={{ x: spring.snappy, opacity: { duration: duration.base, ease: ease.outQuart } }}
						className="flex shrink-0 flex-col border-r border-border bg-panel"
						style={{ width: state.tabs.length ? treeWidth : "100%" }}
					>
						<PaneToolbar>
							<span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={projectPath}>
								{projectPath.slice(projectPath.lastIndexOf("/") + 1)}
							</span>
							<IconButton size="sm" label={t("files.refresh")} icon={<ArrowsClockwise />} onClick={() => void useFiles.getState().load(projectPath)} />
						</PaneToolbar>
						<ul
							ref={treeRef}
							role="tree"
							aria-label={t("files.tree")}
							className="min-h-0 flex-1 overflow-y-auto py-1"
							onKeyDown={event => onTreeKeyDown(event, projectPath)}
						>
							{roots === undefined ? (
								<li className="px-3 py-2 text-sm text-fg-muted">{t("files.loading")}</li>
							) : roots === "error" ? (
								<li className="px-3 py-2 text-sm text-err">{t("files.cantOpen")}</li>
							) : (
								roots.map(entry => <TreeRow key={entry.path} entry={entry} depth={0} projectPath={projectPath} tabId={tabId} />)
							)}
						</ul>
						<p className="border-t border-border px-3 py-1.5 text-xs text-fg-faint">{t("files.mentionHint")}</p>
					</motion.div>
				)}
			</AnimatePresence>
			{/* popLayout: when the last tab closes, the viewer keeps its box and fades out while the tree widens. */}
			<AnimatePresence initial={false} mode="popLayout">
				{state.tabs.length > 0 && (
					<motion.div
						key="viewer"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0, transition: { duration: duration.fast, ease: "easeIn" } }}
						transition={{ duration: duration.base, ease: ease.outQuart }}
						className="flex min-w-0 flex-1"
					>
						{treeShown && (
							// biome-ignore lint/a11y/noStaticElementInteractions: pointer-only resize handle; width also fits content
							<div aria-hidden className="w-1 shrink-0 cursor-col-resize hover:bg-accent/40" onPointerDown={startResize} />
						)}
						<div className="flex min-w-0 flex-1 flex-col">
							<TabStrip
								label={t("files.openFiles")}
								tabs={tabs}
								active={state.active}
								onSelect={path => useFiles.getState().activate(projectPath, path)}
								onClose={path => useFiles.getState().close(projectPath, path)}
								closeLabel={tab => t("files.closeTab", { name: tab.label })}
								leading={
									<IconButton
										className="m-0.5"
										size="sm"
										label={treeShown ? t("files.hideTree") : t("files.showTree")}
										icon={<SidebarSimple />}
										onClick={() => useFiles.getState().setTreeHidden(projectPath, treeShown)}
									/>
								}
							/>
							{state.active && (
								<PresenceSwap swapKey={state.active} className="flex min-h-0 flex-1 flex-col">
									<Viewer path={state.active} projectPath={projectPath} home={home} version={git.version} />
								</PresenceSwap>
							)}
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
