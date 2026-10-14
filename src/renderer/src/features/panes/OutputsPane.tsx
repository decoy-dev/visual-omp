/**
 * Outputs pane (DESIGN §3.7): the images, PDFs and files omp created, wrote, changed or viewed in the focused chat,
 * newest first, in one section per relationship (`OutputRelation`). Besides the files tools name as outputs, main checks the
 * paths each command named for files modified while it ran (best effort). Images load from disk when they have a path,
 * so a re-rendered file shows its current state; images without a file fall back to the data in the tool result (or
 * omp's blob store for saved chats). PDFs show the operating system's thumbnail when it provides one and open in
 * Chromium's PDF viewer inside the pane. Clicking a file opens it in the Files pane.
 */
import { ArrowLeft, ArrowSquareOut, Copy, FileCode, FileIcon, FolderSimpleDashed, Images } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PaneProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { cn, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, EmptyState, IconButton, PresenceSwap, toast } from "../../ui";
import { focusRingInset } from "../../ui/styles";
import { FileName, listRowMotion, PaneToolbar, relativePath, Section, SectionCount } from "./common";
import { type ChatOutput, IMAGE_EXT, isIntactBase64, OPENABLE_EXT, type OutputRelation } from "./derive";
import { openInFiles } from "./files-store";
import { languageFor } from "./highlight";
import { ExpandPreview, loadFileImage, openWithDefaultApp, PdfFrame, PreviewImage, revealLabel, ThumbnailFrame, useNearView, type ZoomControl } from "./media";
import { countOutputsMount, useChatOutputs } from "./outputs-store";

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
	zoom,
}: { output: ChatOutput; mount: number; enabled: boolean; alt: string; explain?: boolean; className?: string; zoom?: boolean | ZoomControl }) {
	return (
		<PreviewImage
			sourceKey={`${mount}|${output.key}@${output.time}`}
			load={() => loadImage(output)}
			pdf={output.kind === "pdf"}
			enabled={enabled}
			alt={alt}
			explain={explain}
			className={className}
			zoom={zoom}
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

/** The path as the pane shows it: project-relative inside the project, else as given; the name for images without one. */
function displayPath(output: ChatOutput, name: string, projectPath: string | null): string {
	if (!output.path) return name;
	return projectPath ? relativePath(projectPath, output.path) : output.path;
}

function PreviewTile({ output, mount, projectPath, onOpen }: { output: ChatOutput; mount: number; projectPath: string | null; onOpen(key: string): void }) {
	const { t } = useTranslation("panes");
	const name = useOutputName(output);
	const when = useWhen(output);
	const [ref, near] = useNearView<HTMLButtonElement>();
	return (
		<motion.li layout="position" {...listRowMotion}>
			<OutputMenu output={output} projectPath={projectPath}>
				<button
					ref={ref}
					type="button"
					data-output={output.key}
					onClick={() => onOpen(output.key)}
					aria-label={t("outputs.openImage", { name: displayPath(output, name, projectPath), when })}
					title={output.path ?? name}
					className={cn("flex w-full flex-col gap-1.5 rounded-md p-1 text-left hover:bg-hover", focusRingInset)}
				>
					<ThumbnailFrame pdf={output.kind === "pdf"}>
						<OutputImage output={output} mount={mount} enabled={near} alt="" className="size-full object-contain" />
					</ThumbnailFrame>
					<FileName name={name} className="px-0.5 text-xs text-fg-muted" />
				</button>
			</OutputMenu>
		</motion.li>
	);
}

function FileRow({ output, projectPath }: { output: ChatOutput; projectPath: string | null }) {
	const { t } = useTranslation("panes");
	const path = output.path ?? "";
	const name = baseName(path);
	const folder = path.slice(0, path.length - name.length - 1);
	const shownFolder = projectPath ? relativePath(projectPath, folder) : folder;
	const when = useWhen(output);
	const Icon = languageFor(name) ? FileCode : FileIcon;
	return (
		<motion.li layout="position" {...listRowMotion}>
			<OutputMenu output={output} projectPath={projectPath}>
				<button
					type="button"
					data-output={output.key}
					onClick={() => openFile(path, projectPath)}
					aria-label={t("outputs.openFile", { path: displayPath(output, name, projectPath), when })}
					title={path}
					className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover", focusRingInset)}
				>
					<Icon aria-hidden className="mt-px size-4 shrink-0 text-fg-faint" />
					<span aria-hidden className="min-w-0 flex-1">
						<FileName name={name} className="text-sm text-fg" />
						<span className="flex gap-2 text-xs text-fg-faint">
							{/* Files at the project root have no folder worth showing ("."). */}
							<span className="min-w-0 flex-1 truncate">{shownFolder === "." ? "" : shownFolder}</span>
							<span className="shrink-0">{when}</span>
						</span>
					</span>
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

function FileList({ outputs, projectPath }: { outputs: ChatOutput[]; projectPath: string | null }) {
	return (
		<ul className="-mx-2 space-y-px">
			<AnimatePresence initial={false}>
				{outputs.map(output => (
					<FileRow key={output.key} output={output} projectPath={projectPath} />
				))}
			</AnimatePresence>
		</ul>
	);
}

const RELATIONS: readonly OutputRelation[] = ["created", "written", "changed", "viewed"];

/**
 * One section per relationship: created, written (new or replaced, history can't tell), changed, viewed. Each shows its
 * images and PDFs as tiles, then its other files as rows. Viewed holds only images and PDFs and is capped, so a long
 * run of review renders doesn't bury the rest.
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
	// Back from the viewer: focus returns to the tile that opened it.
	useEffect(() => {
		if (!restoreKey) return;
		for (const element of listRef.current?.querySelectorAll<HTMLElement>("[data-output]") ?? []) {
			if (element.dataset.output === restoreKey) element.focus();
		}
	}, [restoreKey]);
	return (
		<div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
			{RELATIONS.map(relation => {
				const all = outputs.filter(output => output.relation === relation);
				if (all.length === 0) return null;
				const previews = all.filter(output => output.kind !== "file");
				const shown = relation === "viewed" && !showAllViewed ? previews.slice(0, VIEWED_LIMIT) : previews;
				const files = all.filter(output => output.kind === "file");
				return (
					<Section key={relation} title={t(`outputs.${relation}.title`)} description={t(`outputs.${relation}.description`)} count={<SectionCount count={all.length} />}>
						{shown.length > 0 && <PreviewGrid outputs={shown} mount={mount} projectPath={projectPath} onOpen={onOpen} />}
						{shown.length < previews.length && (
							<button
								type="button"
								onClick={onShowAllViewed}
								className={cn("mt-1 h-7 rounded-md px-1 text-left text-sm text-fg-muted hover:bg-hover hover:text-fg", focusRingInset)}
							>
								{t("outputs.moreViewed", { count: previews.length - shown.length })}
							</button>
						)}
						{files.length > 0 && (
							<div className={shown.length > 0 ? "mt-2" : undefined}>
								<FileList outputs={files} projectPath={projectPath} />
							</div>
						)}
					</Section>
				);
			})}
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
				<span className="flex min-w-0 flex-1" title={path ?? name}>
					<FileName name={name} className="font-mono text-xs text-fg-muted" />
				</span>
				<ExpandPreview
					name={name}
					path={path}
					image={output.kind !== "pdf" || !path}
					render={zoom =>
						output.kind === "pdf" && path ? (
							<PdfFrame path={path} revision={output.time} name={name} />
						) : (
							<OutputImage output={output} mount={mount} enabled explain alt={name} zoom={zoom} />
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
				<div className="flex min-h-0 flex-1 items-center justify-center bg-inset">
					<OutputImage output={output} mount={mount} enabled explain alt={name} zoom className="rounded-md border border-border" />
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
	const [mount] = useState(countOutputsMount);
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
