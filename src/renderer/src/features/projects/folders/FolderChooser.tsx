/**
 * "Start a chat in…": pick the folder a chat runs in. The list view shows projects (newest first)
 * with a filter; Browse… opens the in-app folder browser and the last button opens the system
 * picker. With `tabId` the choice moves that unsent chat instead of opening a new one; with
 * `purpose: "open"` the folder is added as a project and its home opens.
 */
import { Folder, FolderOpen, MagnifyingGlass } from "@phosphor-icons/react";
import type { RecentFolder } from "@shared/contracts/project";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import { Button, Chip, cn, Dialog, DialogContent, Expand, PresenceSwap, SearchInput } from "@/ui";
import { addProject, errorText, startChatIn } from "../actions";
import { type EscapeHandler, FolderBrowser, nativePickerLabel, useHomeDir } from "./FolderBrowser";
import { tildePath, typedPath } from "./paths";

const WINDOWS = window.vomp.platform === "win32";

export interface FolderChooserProps {
	/** `chat` (default): start a chat in the folder. `open`: add it as a project and show its home. */
	purpose?: "chat" | "open";
	/** Move this chat (nothing sent yet) to the chosen folder instead of opening a new chat. */
	tabId?: string;
	/** Open straight in the folder browser. */
	browse?: boolean;
}

export function FolderChooser({ props, close }: SheetProps<FolderChooserProps | undefined>): ReactNode {
	const { t } = useTranslation("projects");
	const purpose = props?.purpose ?? "chat";
	const tabId = props?.tabId;
	const currentPath = useApp(state => (tabId ? state.tabs.find(tab => tab.id === tabId)?.projectPath : state.activeProject) ?? null);
	const [view, setView] = useState<"list" | "browse">(props?.browse || purpose === "open" ? "browse" : "list");
	const [browseFrom, setBrowseFrom] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const escape = useRef<EscapeHandler | null>(null);

	const confirm = async (path: string) => {
		if (busy) return;
		if (tabId && path === currentPath) {
			close();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			if (purpose === "open") await addProject(path);
			else await startChatIn(path, tabId);
			close();
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			setBusy(false);
		}
	};

	const confirmLabel = (name: string) => (purpose === "open" ? t("chooser.openIn", { name }) : t("chooser.startIn", { name }));
	const title = purpose === "open" ? t("chooser.openTitle") : tabId ? t("chooser.moveTitle") : t("chooser.title");
	const description = purpose === "open" ? t("chooser.openBody") : tabId ? t("chooser.moveBody") : t("chooser.body");

	return (
		<Dialog open onOpenChange={open => !open && close()}>
			<DialogContent
				size="xl"
				title={title}
				description={description}
				onEscapeKeyDown={event => {
					if (escape.current?.()) event.preventDefault();
				}}
			>
				<PresenceSwap swapKey={view} variant="slide" direction={view === "browse" ? 1 : -1}>
				{view === "list" ? (
					<ChooserList
						currentPath={currentPath}
						currentLabel={tabId ? t("chooser.thisChat") : t("chooser.current")}
						escapeRef={escape}
						busy={busy}
						onPick={path => void confirm(path)}
						onBrowse={path => {
							setBrowseFrom(path);
							setView("browse");
						}}
						onCancel={close}
					/>
				) : (
					<FolderBrowser
						initialPath={browseFrom}
						confirmLabel={confirmLabel}
						onConfirm={path => void confirm(path)}
						onCancel={close}
						onBack={purpose === "open" || props?.browse ? undefined : () => setView("list")}
						busy={busy}
						escapeRef={escape}
					/>
				)}
				</PresenceSwap>
				<Expand open={Boolean(error)}>
					<p role="alert" className="mt-3 rounded-md bg-err-bg px-3 py-2 text-sm text-err">
						{error}
					</p>
				</Expand>
			</DialogContent>
		</Dialog>
	);
}

interface ChooserListProps {
	currentPath: string | null;
	currentLabel: string;
	escapeRef: RefObject<EscapeHandler | null>;
	busy: boolean;
	onPick(path: string): void;
	/** Open the folder browser, at `path` when given. */
	onBrowse(path?: string): void;
	onCancel(): void;
}

type Option = { kind: "go"; path: string } | { kind: "folder"; folder: RecentFolder };

function ChooserList({ currentPath, currentLabel, escapeRef, busy, onPick, onBrowse, onCancel }: ChooserListProps): ReactNode {
	const { t } = useTranslation("projects");
	const home = useHomeDir();
	const [folders, setFolders] = useState<RecentFolder[] | null>(null);
	const [filter, setFilter] = useState("");
	const [active, setActive] = useState(0);
	const listId = useId();

	useEffect(() => {
		let live = true;
		void window.vomp.invoke("project:recent", 50).then(
			list => live && setFolders(list.filter(folder => folder.exists)),
			() => live && setFolders([]),
		);
		return () => {
			live = false;
		};
	}, []);

	useEffect(() => {
		escapeRef.current = () => {
			if (!filter) return false;
			setFilter("");
			return true;
		};
	});

	const query = filter.trim().toLowerCase();
	const typed = home ? typedPath(filter, home, WINDOWS) : null;
	const ordered = [...(folders ?? [])].sort((a, b) => Number(b.path === currentPath) - Number(a.path === currentPath));
	const matching = query ? ordered.filter(folder => folder.name.toLowerCase().includes(query) || folder.path.toLowerCase().includes(query)) : ordered;
	const options: Option[] = [...(typed ? [{ kind: "go" as const, path: typed }] : []), ...matching.map(folder => ({ kind: "folder" as const, folder }))];
	const activeIndex = Math.min(active, options.length - 1);
	const optionId = (index: number) => `${listId}-o${index}`;

	useLayoutEffect(() => {
		if (activeIndex >= 0) document.getElementById(`${listId}-o${activeIndex}`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, listId]);

	const choose = (option: Option | undefined) => {
		if (!option || busy) return;
		if (option.kind === "go") onBrowse(option.path);
		else onPick(option.folder.path);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (options.length === 0) return;
			const delta = event.key === "ArrowDown" ? 1 : -1;
			setActive((activeIndex + delta + options.length) % options.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			choose(options[activeIndex]);
		}
	};

	const pickNative = async () => {
		const picked = await window.vomp.invoke("app:pickFolder", t("browser.nativeTitle"));
		if (picked) onPick(picked);
	};

	return (
		<div className="flex flex-col">
			<SearchInput
				autoFocus
				value={filter}
				onValueChange={value => {
					setFilter(value);
					setActive(0);
				}}
				placeholder={t("chooser.filter")}
				aria-label={t("chooser.filterLabel")}
				role="combobox"
				aria-expanded
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
				onKeyDown={onKeyDown}
			/>
			<div className="mt-3 h-[min(360px,calc(100vh-300px))] min-h-[200px] overflow-y-auto rounded-md border border-border bg-panel">
				<ul id={listId} role="listbox" aria-label={t("chooser.listLabel")} className="flex flex-col p-1">
					{options.map((option, index) => {
						const selected = index === activeIndex;
						const rowClass = cn(
							"flex min-h-11 cursor-default items-center gap-3 rounded-sm px-2 py-1.5 select-none",
							selected ? "bg-selected" : "hover:bg-hover",
						);
						if (option.kind === "go") {
							return (
								<li key="go" id={optionId(index)} role="option" aria-selected={selected} className={rowClass} onMouseMove={() => setActive(index)} onClick={() => choose(option)}>
									<MagnifyingGlass className="size-4 shrink-0 text-fg-muted" aria-hidden />
									<span className="min-w-0 flex-1 truncate text-md text-fg">{t("chooser.goTo", { path: tildePath(option.path, home) })}</span>
								</li>
							);
						}
						const { folder } = option;
						return (
							<li
								key={folder.path}
								id={optionId(index)}
								role="option"
								aria-selected={selected}
								className={rowClass}
								onMouseMove={() => setActive(index)}
								onClick={() => choose(option)}
							>
								<Folder className="size-4 shrink-0 text-fg-muted" aria-hidden />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-md font-medium text-fg">{folder.name}</span>
									<span className="block truncate font-mono text-xs text-fg-muted">{tildePath(folder.path, home)}</span>
								</span>
								{folder.path === currentPath ? (
									<Chip tone="accent">{currentLabel}</Chip>
								) : (
									folder.sessionCount > 0 && <span className="shrink-0 text-sm text-fg-muted">{t("chooser.chats", { count: folder.sessionCount })}</span>
								)}
							</li>
						);
					})}
				</ul>
				{folders !== null && options.length === 0 && (
					<p className="px-4 py-6 text-center text-md text-fg-muted">{query ? t("chooser.noMatch", { q: filter.trim() }) : t("chooser.empty")}</p>
				)}
			</div>
			<div className="flex items-center gap-2 pt-5">
				<Button icon={<FolderOpen />} onClick={() => onBrowse()}>
					{t("chooser.browse")}
				</Button>
				<Button variant="ghost" onClick={() => void pickNative()}>
					{nativePickerLabel(t)}
				</Button>
				<div className="flex-1" />
				<Button variant="secondary" onClick={onCancel}>
					{t("browser.cancel")}
				</Button>
			</div>
		</div>
	);
}
