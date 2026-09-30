/**
 * In-app folder browser: a clickable breadcrumb, quick places, the current folder's subfolders with
 * git/project badges, an inline "New folder" form, and a primary action for the highlighted folder
 * (or the current one when nothing is highlighted).
 *
 * Keyboard (focus stays in the filter box, a combobox over the folder list): type to filter,
 * ↑/↓ to highlight, Enter to open the highlighted folder (or go to a typed path such as `~/code`),
 * Backspace in an empty box or ⌘↑ (Alt+↑ on Windows) to go up, ⌘↵ (Ctrl+↵) for the primary action.
 */
import {
	ArrowUp,
	Briefcase,
	CaretRight,
	Code,
	Desktop,
	Files,
	Folder,
	FolderPlus,
	GitBranch,
	House,
	WarningCircle,
} from "@phosphor-icons/react";
import type { FolderListing, FolderProblem, ProjectNameProblem, QuickPlace, QuickPlaceId } from "@shared/contracts/project";
import { motion } from "motion/react";
import {
	createContext,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/state/app";
import { Button, Checkbox, Chip, cn, Dialog, DialogContent, Expand, IconButton, Input, PresenceSwap, SearchInput, Spinner, spring } from "@/ui";
import { CheckFailure } from "../CheckFailure";
import { folderName } from "../format";
import { useDebouncedCheck } from "../useDebouncedCheck";
import { filterByName, pathSegments, tildePath, typedPath } from "./paths";

const PLATFORM = window.vomp.platform;
const WINDOWS = PLATFORM === "win32";
const MAC = PLATFORM === "darwin";

const PLACE_ICONS: Record<QuickPlaceId, ReactNode> = {
	home: <House />,
	desktop: <Desktop />,
	documents: <Files />,
	projects: <Briefcase />,
	developer: <Code />,
};

/** Returns true when it handled Escape (the dialog then stays open). */
export type EscapeHandler = () => boolean;

let homeDir: Promise<string> | null = null;

/** The user's home folder (cached for the session). */
export function useHomeDir(): string | null {
	const [home, setHome] = useState<string | null>(null);
	useEffect(() => {
		homeDir ??= window.vomp.invoke("app:info").then(info => info.homeDir);
		let live = true;
		void homeDir.then(value => live && setHome(value));
		return () => {
			live = false;
		};
	}, []);
	return home;
}

/** Label for the button that opens the operating system's own folder picker. */
export function nativePickerLabel(t: (key: string) => string): string {
	return t(MAC ? "browser.native.mac" : WINDOWS ? "browser.native.windows" : "browser.native.other");
}

export interface FolderBrowserProps {
	/** Folder shown first; defaults to the home folder. */
	initialPath?: string;
	/** Primary button text for the folder it acts on (`name` is that folder's name). */
	confirmLabel(name: string): string;
	onConfirm(path: string): void;
	onCancel(): void;
	/** Replaces Cancel with Back (the chooser's list view). */
	onBack?(): void;
	busy?: boolean;
	/** Set by the browser so the surrounding dialog's Escape first closes the New folder form or clears the filter. */
	escapeRef?: RefObject<EscapeHandler | null>;
}

const NAME_CHECK_DELAY_MS = 150;

export function FolderBrowser({ initialPath, confirmLabel, onConfirm, onCancel, onBack, busy = false, escapeRef }: FolderBrowserProps): ReactNode {
	const { t } = useTranslation("projects");
	const home = useHomeDir();
	const projects = useApp(state => state.projects);
	const [places, setPlaces] = useState<QuickPlace[]>([]);
	const [listing, setListing] = useState<FolderListing | null>(null);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState("");
	const [showHidden, setShowHidden] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const request = useRef(0);
	const filterRef = useRef<HTMLInputElement>(null);
	const listId = useId();

	const go = useCallback(async (path: string, highlight?: string) => {
		const id = ++request.current;
		setLoading(true);
		const next: FolderListing = await window.vomp
			.invoke("project:listDir", path)
			.catch(() => ({ ok: false as const, problem: "unreadable" as const, path }));
		if (id !== request.current) return;
		setListing(next);
		setLoading(false);
		setFilter("");
		setCreating(false);
		setSelected(highlight ?? null);
		filterRef.current?.focus();
	}, []);

	useEffect(() => {
		let live = true;
		void window.vomp.invoke("project:places").then(
			list => live && setPlaces(list),
			() => {},
		);
		return () => {
			live = false;
		};
	}, []);

	// First folder: the requested one, else home once it is known.
	const started = useRef(false);
	useEffect(() => {
		if (started.current) return;
		const first = initialPath ?? home;
		if (!first) return;
		started.current = true;
		void go(first);
	}, [initialPath, home, go]);

	const current = listing?.path ?? initialPath ?? home;
	const segments = current ? pathSegments(current, WINDOWS) : [];
	const parent = listing?.ok ? listing.parent : (segments.at(-2)?.path ?? null);
	const entries = listing?.ok ? filterByName(showHidden ? listing.entries : listing.entries.filter(entry => !entry.hidden), filter) : [];
	const hiddenCount = listing?.ok ? listing.entries.filter(entry => entry.hidden).length : 0;
	const typed = home ? typedPath(filter, home, WINDOWS) : null;
	const selectedIndex = selected ? entries.findIndex(entry => entry.path === selected) : -1;
	// While filtering, the best match is highlighted without an explicit pick.
	const activeIndex = selectedIndex >= 0 ? selectedIndex : filter.trim() && !typed && entries.length > 0 ? 0 : -1;
	const active = entries[activeIndex] ?? null;
	// While a folder is loading, nothing is actionable: the old listing must not receive the chat.
	const target = loading ? null : (active?.path ?? (listing?.ok ? listing.path : null));
	const optionId = (index: number) => `${listId}-o${index}`;

	useLayoutEffect(() => {
		if (activeIndex >= 0) document.getElementById(`${listId}-o${activeIndex}`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, listId]);

	const goUp = () => {
		if (parent && current) void go(parent, current);
	};

	useEffect(() => {
		if (!escapeRef) return;
		escapeRef.current = () => {
			if (creating) {
				setCreating(false);
				filterRef.current?.focus();
				return true;
			}
			if (filter) {
				setFilter("");
				return true;
			}
			return false;
		};
	});

	const move = (delta: number) => {
		if (entries.length === 0) return;
		const from = activeIndex < 0 ? (delta > 0 ? -1 : entries.length) : activeIndex;
		const next = Math.max(0, Math.min(entries.length - 1, from + delta));
		setSelected(entries[next]?.path ?? null);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.nativeEvent.isComposing) return;
		const jump = MAC ? event.metaKey : event.altKey;
		if ((event.key === "ArrowUp" && jump) || (event.key === "Backspace" && !filter)) {
			event.preventDefault();
			goUp();
			return;
		}
		if (event.key === "ArrowDown" && jump) {
			event.preventDefault();
			if (active) void go(active.path);
			return;
		}
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				move(1);
				break;
			case "ArrowUp":
				event.preventDefault();
				move(-1);
				break;
			case "PageDown":
				event.preventDefault();
				move(10);
				break;
			case "PageUp":
				event.preventDefault();
				move(-10);
				break;
			case "Enter":
				event.preventDefault();
				if (MAC ? event.metaKey : event.ctrlKey) {
					if (target && !busy) onConfirm(target);
				} else if (typed) void go(typed);
				else if (active) void go(active.path);
				break;
		}
	};

	const pickNative = async () => {
		const picked = await window.vomp.invoke("app:pickFolder", t("browser.nativeTitle"));
		if (picked) onConfirm(picked);
	};

	// Opening a subfolder slides the new listing in from the right; going up slides it in from the left.
	const shownPath = listing?.path ?? null;
	const [trail, setTrail] = useState<{ path: string | null; direction: 1 | -1 }>({ path: shownPath, direction: 1 });
	if (trail.path !== shownPath) setTrail({ path: shownPath, direction: trail.path && shownPath && trail.path.startsWith(shownPath) ? -1 : 1 });

	const listingName = current ? folderName(current) : "";
	const primaryLabel = confirmLabel(target ? folderName(target) : listingName);
	const status = loading
		? t("browser.loading")
		: listing?.ok
			? t("browser.status", { name: listingName, count: entries.length })
			: listing
				? t(`browser.problem.${listing.problem}`)
				: "";

	return (
		<div className="flex flex-col">
			<div className="flex h-[min(440px,calc(100vh-240px))] min-h-[280px] gap-4">
				<PlaceScope.Provider value={listId}>
				<nav aria-label={t("browser.places")} className="-ml-2 w-40 shrink-0 overflow-y-auto">
					<ul className="flex flex-col gap-px">
						{places.map(place => (
							<li key={place.id}>
								<PlaceButton icon={PLACE_ICONS[place.id]} label={t(`browser.place.${place.id}`)} path={place.path} current={current} onGo={path => void go(path)} />
							</li>
						))}
					</ul>
					{projects.some(project => project.exists) && (
						<>
							<h3 className="mt-4 mb-1 px-2 text-sm font-medium text-fg-muted">{t("browser.projects")}</h3>
							<ul className="flex flex-col gap-px">
								{projects
									.filter(project => project.exists)
									.map(project => (
										<li key={project.path}>
											<PlaceButton icon={<Folder />} label={project.name} path={project.path} current={current} onGo={path => void go(path)} />
										</li>
									))}
							</ul>
						</>
					)}
				</nav>
				</PlaceScope.Provider>

				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex items-center gap-2">
						<Breadcrumb segments={segments} onGo={(path, highlight) => void go(path, highlight)} />
						{listing?.ok && listing.isProject && <Chip tone="accent">{t("browser.badge.project")}</Chip>}
						{listing?.ok && listing.isGitRepo && <Chip icon={<GitBranch />}>{t("browser.badge.git")}</Chip>}
					</div>

					<div className="mt-2 flex items-center gap-2">
						<IconButton
							label={t("browser.up")}
							shortcut={MAC ? "⌘↑" : "Alt+↑"}
							icon={<ArrowUp />}
							disabled={!parent}
							onClick={goUp}
						/>
						<SearchInput
							ref={filterRef}
							autoFocus
							className="min-w-0 flex-1"
							value={filter}
							onValueChange={value => {
								setFilter(value);
								setSelected(null);
							}}
							placeholder={t("browser.filter")}
							aria-label={t("browser.filterLabel", { name: listingName })}
							role="combobox"
							aria-expanded
							aria-controls={listId}
							aria-autocomplete="list"
							aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
							aria-keyshortcuts={MAC ? "Meta+ArrowUp Backspace Meta+Enter" : "Alt+ArrowUp Backspace Control+Enter"}
							onKeyDown={onKeyDown}
						/>
						<Checkbox label={t("browser.showHidden")} checked={showHidden} onCheckedChange={setShowHidden} />
						<Button icon={<FolderPlus />} disabled={!listing?.ok} onClick={() => setCreating(true)}>
							{t("browser.newFolder.button")}
						</Button>
					</div>

					<Expand open={creating && Boolean(listing?.ok)}>
						{listing?.ok && (
							<NewFolderForm
								parent={listing.path}
								onCreated={path => void go(path)}
								onCancel={() => {
									setCreating(false);
									filterRef.current?.focus();
								}}
							/>
						)}
					</Expand>

					<Expand open={Boolean(typed)}>
						<p className="mt-2 text-sm text-fg-muted">{typed && t("browser.goTo", { path: tildePath(typed, home) })}</p>
					</Expand>

					<div
						className={cn(
							"relative mt-2 min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-md border border-border bg-panel transition-opacity duration-(--dur)",
							loading && "opacity-60",
						)}
					>
						<PresenceSwap swapKey={shownPath ?? ""} variant="slide" direction={trail.direction} className="flex min-h-full flex-col">
						{listing && !listing.ok ? (
							<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
								<WarningCircle className="size-6 text-warn" aria-hidden />
								<p className="text-md text-fg">{t(`browser.problem.${listing.problem}`)}</p>
								{home && (
									<Button size="sm" icon={<House />} onClick={() => void go(home)}>
										{t("browser.goHome")}
									</Button>
								)}
							</div>
						) : (
							<ul id={listId} role="listbox" aria-label={t("browser.listLabel", { name: listingName })} className="flex flex-col p-1">
								{entries.map((entry, index) => (
									<li
										key={entry.path}
										id={optionId(index)}
										role="option"
										aria-selected={index === activeIndex}
										onClick={() => {
											setSelected(entry.path);
											filterRef.current?.focus();
										}}
										onDoubleClick={() => void go(entry.path)}
										className={cn(
											"flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-md select-none",
											index === activeIndex ? "bg-selected text-fg" : "text-fg hover:bg-hover",
											entry.hidden && "text-fg-muted",
										)}
									>
										<Folder className="size-4 shrink-0 text-fg-muted" weight={entry.isProject ? "fill" : "regular"} aria-hidden />
										<span className="min-w-0 flex-1 truncate">{entry.name}</span>
										{entry.isProject && <Chip tone="accent">{t("browser.badge.project")}</Chip>}
										{entry.isGitRepo && <Chip icon={<GitBranch />}>{t("browser.badge.git")}</Chip>}
										<CaretRight className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
									</li>
								))}
							</ul>
						)}
						{listing?.ok && entries.length === 0 && !loading && (
							<p className="px-4 py-6 text-center text-md text-fg-muted">
								{filter.trim() && !typed
									? t("browser.noMatch", { q: filter.trim() })
									: hiddenCount > 0 && !showHidden
										? t("browser.onlyHidden", { count: hiddenCount })
										: t("browser.empty")}
							</p>
						)}
						{listing?.ok && listing.truncated && <p className="px-4 py-2 text-sm text-fg-muted">{t("browser.truncated")}</p>}
						</PresenceSwap>
						{loading && (
							<span className="absolute top-2 right-2">
								<Spinner size={14} />
							</span>
						)}
					</div>
					<p className="mt-1.5 text-xs text-fg-muted">{t(MAC ? "browser.keysMac" : "browser.keysOther")}</p>
					<p className="sr-only" role="status" aria-live="polite">
						{status}
					</p>
				</div>
			</div>

			<div className="flex items-center gap-2 pt-5">
				<Button variant="ghost" onClick={() => void pickNative()}>
					{nativePickerLabel(t)}
				</Button>
				<div className="flex-1" />
				<Button variant="secondary" onClick={onBack ?? onCancel}>
					{onBack ? t("browser.back") : t("browser.cancel")}
				</Button>
				<Button
					variant="primary"
					className="max-w-72 min-w-0 [&>span]:min-w-0"
					disabled={!target || busy}
					loading={busy}
					aria-label={primaryLabel}
					title={primaryLabel}
					onClick={() => target && onConfirm(target)}
				>
					<span className="min-w-0 truncate">{primaryLabel}</span>
				</Button>
			</div>
		</div>
	);
}

/** Layout id prefix for the sidebar highlight, so it slides to the place the browser moved to. */
const PlaceScope = createContext("places");

function PlaceButton({ icon, label, path, current, onGo }: { icon: ReactNode; label: string; path: string; current: string | null; onGo(path: string): void }): ReactNode {
	const here = current === path;
	const scope = useContext(PlaceScope);
	return (
		<button
			type="button"
			title={path}
			aria-current={here ? "location" : undefined}
			onClick={() => onGo(path)}
			className={cn(
				"relative isolate flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-md outline-none focus-visible:outline-2 focus-visible:outline-ring",
				"[&>svg]:size-4 [&>svg]:shrink-0",
				here ? "font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
			)}
		>
			{here && <motion.span aria-hidden layoutId={`${scope}-here`} transition={spring.snappy} className="absolute inset-0 -z-10 rounded-md bg-selected" />}
			{icon}
			<span className="truncate">{label}</span>
		</button>
	);
}

function Breadcrumb({ segments, onGo }: { segments: { name: string; path: string }[]; onGo(path: string, highlight?: string): void }): ReactNode {
	const { t } = useTranslation("projects");
	const scroller = useRef<HTMLElement>(null);
	const last = segments.at(-1)?.path;
	useLayoutEffect(() => {
		if (last && scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
	}, [last]);
	return (
		<nav ref={scroller} aria-label={t("browser.path")} className="min-w-0 flex-1 overflow-x-auto">
			<ol className="flex items-center gap-0.5 whitespace-nowrap">
				{segments.map((segment, index) => {
					const isLast = index === segments.length - 1;
					return (
						<li key={segment.path} className="flex items-center gap-0.5">
							{index > 0 && <CaretRight className="size-3 shrink-0 text-fg-faint" aria-hidden />}
							<button
								type="button"
								aria-current={isLast ? "location" : undefined}
								aria-label={index === 0 && !WINDOWS ? t("browser.root") : undefined}
								onClick={() => onGo(segment.path, segments[index + 1]?.path)}
								className={cn(
									"h-7 rounded-sm px-1.5 text-md outline-none focus-visible:outline-2 focus-visible:outline-ring",
									isLast ? "font-semibold text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
								)}
							>
								{segment.name}
							</button>
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Problem codes about the folder itself rather than the typed name. */
const FOLDER_PROBLEMS: Record<FolderProblem, true> = { notAbsolute: true, notFound: true, notDirectory: true, permissionDenied: true, unreadable: true };

/** Message for a rejected new folder. `notDirectory` reads as the name being taken by a file. */
function newFolderProblem(problem: ProjectNameProblem | FolderProblem, t: Translate): string {
	if (problem === "empty") return t("browser.newFolder.empty");
	if (problem === "notDirectory" || !(problem in FOLDER_PROBLEMS)) return t(`new.problem.${problem}`);
	return t(`browser.problem.${problem}`);
}

function NewFolderForm({ parent, onCreated, onCancel }: { parent: string; onCreated(path: string): void; onCancel(): void }): ReactNode {
	const { t } = useTranslation("projects");
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const check = useCallback((value: string) => window.vomp.invoke("project:checkName", value, parent), [parent]);
	const live = useDebouncedCheck(name, NAME_CHECK_DELAY_MS, check, parent);

	const submit = async () => {
		if (busy || !name.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const result = await window.vomp.invoke("project:mkdir", parent, name);
			if (result.ok) onCreated(result.path);
			else setError(newFolderProblem(result.problem, t));
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form
			className="mt-2 flex flex-col gap-1.5 rounded-md bg-inset p-2"
			onSubmit={event => {
				event.preventDefault();
				void submit();
			}}
		>
			<div className="flex items-start gap-2">
				<Input
					autoFocus
					className="min-w-0 flex-1"
					aria-label={t("browser.newFolder.label", { name: folderName(parent) })}
					placeholder={t("browser.newFolder.placeholder")}
					value={name}
					spellCheck={false}
					onChange={event => {
						setName(event.currentTarget.value);
						setError(null);
					}}
					error={live.result?.problem ? newFolderProblem(live.result.problem, t) : undefined}
				/>
				{/* A failed check does not block creating: the create call validates again and reports its own error. */}
				<Button type="submit" variant="primary" disabled={busy || live.pending || !(live.result?.ok || live.error)} loading={busy}>
					{t("browser.newFolder.create")}
				</Button>
				<Button variant="ghost" onClick={onCancel}>
					{t("browser.cancel")}
				</Button>
			</div>
			<CheckFailure message={error ?? (live.error && t("new.checkFailed.name", { reason: live.error }))} />
		</form>
	);
}

export interface FolderBrowserDialogProps extends FolderBrowserProps {
	open: boolean;
	title: string;
	description?: string;
}

/** The folder browser in its own dialog (the new-project wizard's location pickers). */
export function FolderBrowserDialog({ open, title, description, ...browser }: FolderBrowserDialogProps): ReactNode {
	const escape = useRef<EscapeHandler | null>(null);
	return (
		<Dialog open={open} onOpenChange={next => !next && browser.onCancel()}>
			<DialogContent
				size="xl"
				title={title}
				description={description}
				onEscapeKeyDown={event => {
					if (escape.current?.()) event.preventDefault();
				}}
			>
				<FolderBrowser {...browser} escapeRef={escape} />
			</DialogContent>
		</Dialog>
	);
}
