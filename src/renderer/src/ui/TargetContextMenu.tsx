import { ArrowSquareOut, At, Copy, DownloadSimple, File, FolderSimpleDashed, GitDiff, Image, MonitorPlay } from "@phosphor-icons/react";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useHomeDir } from "../features/projects/folders/FolderBrowser";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "./Menu";
import { revealLabel, runContextAction, type ContextScope } from "./contextActions";
import { contextActionIds, contextPath, type ContextActionId, type ContextTarget } from "./contextTargets";
import { selectionContainsTarget } from "./contextSelection";

const icons = { openBrowser: ArrowSquareOut, openPreview: MonitorPlay, copyLink: Copy, open: File, changes: GitDiff, openDefault: ArrowSquareOut, reveal: FolderSimpleDashed, copyPath: Copy, copyRelative: Copy, mention: At, copyImage: Image, saveImage: DownloadSimple };
const labels: Record<ContextActionId, string> = { openBrowser: "context.openBrowser", openPreview: "context.openPreview", copyLink: "context.copyLink", open: "files.open", changes: "context.changes", openDefault: "outputs.openDefault", reveal: "files.reveal", copyPath: "files.copyPath", copyRelative: "context.copyRelative", mention: "files.mention", copyImage: "context.copyImage", saveImage: "context.saveImage" };

/** Identify only actionable content. Ordinary text keeps Electron's selection menu. */
export function targetAt(element: Element, scope: ContextScope, home: string | null): ContextTarget | null {
	if (element.closest("input, textarea, [contenteditable=true], [role=menu]")) return null;
	const linkedFile = element.closest<HTMLElement>("[data-file-path]");
	const marked = linkedFile ?? element.closest<HTMLElement>("[data-context-path], [data-context-tool-path]");
	const raw = linkedFile?.dataset.filePath ?? marked?.dataset.contextPath ?? marked?.dataset.contextToolPath;
	const path = raw ? contextPath(raw, { cwd: scope.projectPath, home }, marked?.hasAttribute("data-context-tool-path") ? "tool" : "literal") : null;
	if (linkedFile && path) return { kind: linkedFile.dataset.fileKind === "folder" || linkedFile.dataset.fileKind === "dir" ? "folder" : "file", path };
	const image = element instanceof HTMLImageElement ? element : element.closest("button, [role=button], [data-context-image]")?.querySelector("img");
	if (image && !image.closest("[data-context-no-image]")) return { kind: "image", source: image.currentSrc || image.src, ...(path ? { path } : {}) };
	if (path) return { kind: marked?.dataset.contextKind === "dir" || marked?.dataset.contextKind === "folder" ? "folder" : "file", path, changes: marked?.hasAttribute("data-context-changes") };
	const anchor = element.closest<HTMLAnchorElement>("a[href]");
	const url = anchor?.getAttribute("href") ?? element.closest<HTMLElement>("[data-context-url]")?.dataset.contextUrl ?? raw;
	return url && /^(?:https?|mailto):/i.test(url) ? { kind: "link", url } : null;
}

/** One delegated boundary also covers Markdown's generated anchors and file links. No click handlers are changed. */
export function TargetContextMenu({ children, projectPath, tabId, target, onShowChanges }: ContextScope & { children: ReactNode; target?: ContextTarget; onShowChanges?(path: string): void }) {
	const { t } = useTranslation("panes");
	const home = useHomeDir();
	const trigger = useRef<HTMLSpanElement>(null);
	const origin = useRef<HTMLElement | null>(null);
	const menuOpen = useRef(false);
	const [selection, setSelection] = useState<{ target: ContextTarget; scope: ContextScope; showChanges?: (path: string) => void } | null>(null);
	const scope = { projectPath, tabId };
	const open = (element: Element, x: number, y: number, keyboard = false) => {
		if (selectionContainsTarget(window.getSelection(), element, keyboard ? undefined : { x, y })) return false;
		const next = target ?? targetAt(element, scope, home);
		if (!next) return false;
		origin.current = element.closest<HTMLElement>("button, a, [tabindex]") ?? (element instanceof HTMLElement ? element : null);
		// Radix places a context menu to either side of its point. Reserve its width when neither side would fit.
		const menuWidth = Math.min(15 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize), window.innerWidth - 16);
		x = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 10));
		flushSync(() => setSelection({ target: next, scope, showChanges: onShowChanges }));
		trigger.current?.dispatchEvent(new globalThis.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
		return true;
	};
	const contextMenu = (event: MouseEvent<HTMLDivElement>) => {
		if (event.defaultPrevented || !(event.target instanceof Element) || event.target === trigger.current) return;
		if (open(event.target, event.clientX, event.clientY)) { event.preventDefault(); event.stopPropagation(); }
	};
	const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.defaultPrevented || !(event.target instanceof Element) || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
		const box = event.target.getBoundingClientRect();
		if (open(event.target, box.left + Math.min(16, box.width / 2), box.bottom, true)) { event.preventDefault(); event.stopPropagation(); }
	};
	return (
		<ContextMenu onOpenChange={open => { menuOpen.current = open; }}>
			<div className="contents" onContextMenu={contextMenu} onKeyDown={keyDown}>
				{children}
				<ContextMenuTrigger ref={trigger} className="hidden" aria-hidden />
			</div>
			<ContextMenuContent className="w-60 max-w-[calc(100vw-16px)]" style={{ minWidth: "min(12.5rem, calc(100vw - 16px))" }} onCloseAutoFocus={event => { event.preventDefault(); if (!menuOpen.current) origin.current?.focus({ preventScroll: true }); }}>
				{selection && contextActionIds(selection.target, selection.scope.projectPath).map((id, index) => {
					const chosen = selection.target;
					const Icon = icons[id];
					let label = id === "reveal" ? revealLabel(t) : id === "mention" ? t("context.mention") : t(labels[id]);
					if (chosen.kind === "folder") {
						if (id === "open") label = t("context.openFolder");
						if (id === "reveal") label = t(window.vomp.platform === "darwin" ? "files.revealFolderMac" : "files.revealFolder");
					}
					return <span key={id} className="contents">
						{index > 0 && (id === "copyLink" || id === "copyPath" || id === "openDefault" && chosen.kind === "image" || id === "mention") && <ContextMenuSeparator />}
						<ContextMenuItem icon={<Icon />} onSelect={() => {
							if (id === "changes" && selection.showChanges && chosen.kind !== "link" && chosen.path) selection.showChanges(chosen.path);
							else void runContextAction(id, chosen, selection.scope);
						}}>{label}</ContextMenuItem>
					</span>;
				})}
			</ContextMenuContent>
		</ContextMenu>
	);
}
