/**
 * Project home (DESIGN §4.3): header with this week's activity, recent chats and example prompts, with git state
 * and project instructions in a side column. With no project at all it shows the §8.2 empty state.
 */
import type { ProjectInstructions, ProjectRule } from "@shared/contracts/project";
import type { ProjectWeekStats } from "@shared/contracts/usage";
import type { SessionSummary } from "@shared/ipc";
import { ArrowRight, ChatCenteredDots, DownloadSimple, FileText, FolderMinus, FolderOpen, FolderPlus, GearSix, GitBranch, Plus, SlidersHorizontal, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, type Ref, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScreenProps } from "@/registry/slots";
import { ChatStatusMark } from "@/shell/ChatStatusMark";
import { chatStatus, chatTitle, shortAgo, useNow, useSessionView } from "@/shell/hooks";
import { controllerFor, useApp } from "@/state/app";
import {
	Button,
	Chip,
	cn,
	EmptyState,
	Expand,
	FadeIn,
	IconButton,
	Mark,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	PresenceSwap,
	Skeleton,
	spring,
	toast,
} from "@/ui";
import { initGit } from "../git/actions";
import { ciState } from "../git/format";
import { useGit } from "../git/store";
import { addProject, chooseFolder, errorText, openFolder, startDraft } from "./actions";
import { EXAMPLE_PROMPTS, folderName, formatBytes, formatUsd } from "./format";

const RECENT_LIMIT = 5;

export function HomeScreen({ projectPath }: ScreenProps): ReactNode {
	const hasProjects = useApp(state => state.projects.length > 0);
	if (!projectPath) return <NoProjects hasProjects={hasProjects} />;
	return <ProjectHome key={projectPath} path={projectPath} />;
}

function NoProjects({ hasProjects }: { hasProjects: boolean }): ReactNode {
	const { t } = useTranslation("projects");
	return (
		<EmptyState
			className="m-auto"
			art={<Mark size={48} />}
			title={t(hasProjects ? "home.pickProject" : "home.noProjects")}
			actions={
				<>
					<Button icon={<FolderOpen />} onClick={() => openFolder()}>
						{t("home.openFolder")}
					</Button>
					<Button icon={<Plus />} onClick={() => useApp.getState().openSheet("project-new")}>
						{t("home.newProject")}
					</Button>
					<Button variant="primary" icon={<ChatCenteredDots />} onClick={() => chooseFolder()}>
						{t("home.startIn")}
					</Button>
				</>
			}
		/>
	);
}

/** Reload `load` whenever a sheet closes (the instructions editor, settings…) or `path` changes. */
function useOnSheetClose<T>(path: string, load: (path: string) => Promise<T>): T | null {
	const sheetOpen = useApp(state => state.sheet !== null);
	const [value, setValue] = useState<T | null>(null);
	useEffect(() => {
		if (sheetOpen) return;
		let live = true;
		load(path).then(
			next => live && setValue(next),
			() => live && setValue(null),
		);
		return () => {
			live = false;
		};
	}, [path, sheetOpen, load]);
	return value;
}

const loadInstructions = (path: string) =>
	Promise.all([window.vomp.invoke("project:instructions", path), window.vomp.invoke("project:rules", path)]);

function ProjectHome({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const project = useApp(state => state.projects.find(entry => entry.path === path) ?? null);
	const sessions = useApp(state => state.sessionsByProject[path]);
	const git = useGit(path);
	const [week, setWeek] = useState<ProjectWeekStats | null>(null);
	const instructions = useOnSheetClose(path, loadInstructions);
	const exists = project?.exists ?? true;
	const name = project?.name ?? folderName(path);
	const visible = sessions?.filter(session => !session.archived);

	useEffect(() => {
		if (sessions === undefined) void useApp.getState().loadSessions(path);
	}, [path, sessions]);

	// Session files change as chats run; the sessions list is refreshed on every change.
	useEffect(() => {
		let live = true;
		window.vomp.invoke("usage:projectWeek", path).then(
			stats => live && setWeek(stats),
			() => live && setWeek(null),
		);
		return () => {
			live = false;
		};
	}, [path, sessions]);

	if (!exists) return <MissingFolder path={path} name={name} />;

	const status = git?.status ?? null;
	const notRepo = git !== null && !git.loading && git.repo?.isRepo === false;
	const changed = status?.totals.files ?? 0;

	return (
		// Layout follows the Home pane's own width (a size container), so an open sidebar and dock narrow it correctly.
		<div className="@container min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex max-w-[920px] flex-col gap-10 px-5 pt-6 pb-12 @min-[40rem]:px-8 @min-[40rem]:pt-8">
				<header className="flex flex-wrap items-start gap-x-4 gap-y-3">
					<div className="min-w-[min(100%,16rem)] flex-1">
						<h1 className="truncate text-[28px] font-bold leading-tight tracking-[-0.02em] text-fg" title={path}>
							{name}
						</h1>
						<p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-md text-fg-muted">
							{status?.branch && (
								<>
									<span className="inline-flex items-center gap-1 font-mono text-sm">
										<GitBranch className="size-3.5" aria-hidden />
										{status.branch}
									</span>
									<span aria-hidden>·</span>
									<span>{changed === 0 ? t("home.meta.clean") : t("home.meta.changed", { count: changed })}</span>
									<span aria-hidden>·</span>
								</>
							)}
							{notRepo && (
								<>
									<span>{t("home.meta.noGit")}</span>
									<span aria-hidden>·</span>
								</>
							)}
							{week ? (
								<FadeIn as="span" className="inline-flex flex-wrap items-center gap-x-2">
									<span>
										<span className="font-mono tabular-nums">{week.chats}</span> {t("home.meta.chatsWeek", { count: week.chats })}
									</span>
									<span aria-hidden>·</span>
									<span>
										<span className="font-mono tabular-nums">{formatUsd(week.costUsd)}</span> {t("home.meta.costWeek")}
									</span>
								</FadeIn>
							) : (
								<Skeleton shape="text" width={180} />
							)}
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button icon={<FolderOpen />} onClick={() => chooseFolder()}>
							{t("home.otherFolder")}
						</Button>
						<Button variant="primary" icon={<ChatCenteredDots />} onClick={() => useApp.getState().newChat(path)}>
							{t("home.newChat")}
						</Button>
						<ProjectMenu path={path} />
					</div>
				</header>

				<div className="grid grid-cols-1 gap-10 @min-[46rem]:grid-cols-[minmax(0,1fr)_15.5rem]">
					<div className="flex min-w-0 flex-col gap-10">
						<RecentChats sessions={visible} />
						<PromptStarters path={path} />
					</div>
					<aside className="grid content-start gap-8 @min-[34rem]:grid-cols-2 @min-[46rem]:grid-cols-1 @min-[46rem]:border-l @min-[46rem]:border-border @min-[46rem]:pl-8">
						{notRepo ? <NoGit path={path} /> : <Health path={path} />}
						<Instructions path={path} data={instructions} />
					</aside>
				</div>
			</div>
		</div>
	);
}


function ProjectMenu({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const openSheet = useApp(state => state.openSheet);
	const remove = async () => {
		try {
			await window.vomp.invoke("project:remove", path);
			await useApp.getState().refreshProjects();
			const next = useApp.getState().projects.find(entry => entry.path !== path)?.path ?? null;
			useApp.setState({ activeProject: next });
		} catch (error) {
			toast({ tone: "err", message: t("settings.removeFailed"), description: errorText(error) });
		}
	};
	return (
		<Menu>
			<MenuTrigger asChild>
				<IconButton variant="secondary" size="lg" icon={<GearSix />} label={t("home.menu")} />
			</MenuTrigger>
			<MenuContent align="end">
				<MenuItem icon={<SlidersHorizontal />} onSelect={() => openSheet("project-settings", { projectPath: path })}>
					{t("home.menuSettings")}
				</MenuItem>
				<MenuItem icon={<FileText />} onSelect={() => openSheet("project-instructions", { projectPath: path })}>
					{t("home.menuInstructions")}
				</MenuItem>
				<MenuItem icon={<DownloadSimple />} onSelect={() => openSheet("project-import", { projectPath: path })}>
					{t("home.menuImport")}
				</MenuItem>
				<MenuItem icon={<FolderOpen />} onSelect={() => void window.vomp.invoke("app:showItem", path)}>
					{t("home.menuReveal")}
				</MenuItem>
				<MenuSeparator />
				<MenuItem icon={<X />} danger onSelect={() => void remove()}>
					{t("home.menuRemove")}
				</MenuItem>
			</MenuContent>
		</Menu>
	);
}

function MissingFolder({ path, name }: { path: string; name: string }): ReactNode {
	const { t } = useTranslation("projects");
	const locate = async () => {
		const picked = await window.vomp.invoke("app:pickFolder", t("open.pickerTitle"));
		if (!picked) return;
		try {
			await addProject(picked);
		} catch (error) {
			toast({ tone: "err", message: t("open.failed"), description: errorText(error) });
		}
	};
	return (
		<EmptyState
			className="m-auto"
			icon={<FolderMinus />}
			title={t("home.missing.title", { name })}
			body={t("home.missing.body", { path })}
			actions={
				<>
					<Button onClick={() => void locate()}>{t("home.missing.locate")}</Button>
					<Button
						variant="danger-ghost"
						onClick={() => void window.vomp.invoke("project:remove", path).then(() => useApp.getState().refreshProjects())}
					>
						{t("home.menuRemove")}
					</Button>
				</>
			}
		/>
	);
}


/** A titled group on the home page. Hierarchy comes from the heading and spacing; there is no box around it. */
function Section({ id, title, action, children }: { id: string; title: ReactNode; action?: ReactNode; children: ReactNode }): ReactNode {
	return (
		<section aria-labelledby={id} className="relative">
			<div className="mb-2 flex h-7 items-center gap-2">
				<h2 id={id} className="flex-1 text-base font-semibold text-fg">
					{title}
				</h2>
				{action}
			</div>
			{children}
		</section>
	);
}

/** Crossfades from the loading placeholder to the loaded content; content already loaded at mount renders at rest. */
function Loaded({ ready, placeholder, children }: { ready: boolean; placeholder: ReactNode; children: ReactNode }): ReactNode {
	return (
		<PresenceSwap swapKey={ready ? "ready" : "loading"} mode="popLayout">
			{ready ? children : placeholder}
		</PresenceSwap>
	);
}

function RecentChats({ sessions }: { sessions: SessionSummary[] | undefined }): ReactNode {
	const { t } = useTranslation("projects");
	const now = useNow();
	const id = useId();
	const [all, setAll] = useState(false);
	const first = sessions?.slice(0, RECENT_LIMIT) ?? [];
	const rest = sessions?.slice(RECENT_LIMIT) ?? [];
	return (
		<Section
			id={id}
			title={t("home.recent.title")}
			action={
				rest.length > 0 && (
					<Button variant="ghost" size="sm" onClick={() => setAll(value => !value)} aria-expanded={all}>
						{all ? t("home.recent.fewer") : t("home.recent.all", { count: sessions?.length ?? 0 })}
					</Button>
				)
			}
		>
			<Loaded
				ready={sessions !== undefined}
				placeholder={
					<div className="flex flex-col gap-3 py-1" aria-busy>
						{[0, 1, 2].map(row => (
							<Skeleton key={row} height={20} />
						))}
					</div>
				}
			>
				{first.length === 0 ? (
					<p className="py-1 text-md text-fg-muted">{t("home.recent.empty")}</p>
				) : (
					<div className="-mx-2">
						<ul className="relative flex flex-col">
							<AnimatePresence initial={false} mode="popLayout">
								{first.map(session => (
									<RecentRow key={session.file} session={session} now={now} />
								))}
							</AnimatePresence>
						</ul>
						<Expand open={all}>
							<ul className="relative flex flex-col">
								<AnimatePresence initial={false} mode="popLayout">
									{rest.map(session => (
										<RecentRow key={session.file} session={session} now={now} />
									))}
								</AnimatePresence>
							</ul>
						</Expand>
					</div>
				)}
			</Loaded>
		</Section>
	);
}

function RecentRow({ session, now, ref }: { session: SessionSummary; now: number; ref?: Ref<HTMLLIElement> }): ReactNode {
	const { t } = useTranslation("projects");
	const tab = useApp(state => state.tabs.find(entry => entry.sessionFile === session.file) ?? null);
	const view = useSessionView(controllerFor(tab?.id));
	const status = chatStatus(view);
	const title = chatTitle(view, session.title) ?? session.preview ?? t("home.recent.untitled");
	const statusLabel = t(`home.recent.status.${status}`);
	return (
		<motion.li
			ref={ref}
			layout="position"
			initial={{ opacity: 0, y: -4 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0 }}
			transition={spring.snappy}
		>
			<button
				type="button"
				onClick={() => useApp.getState().openSession(session)}
				title={session.preview ?? undefined}
				className="flex h-10 w-full items-center gap-3 rounded-md px-2 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
			>
				<ChatStatusMark status={status} label={statusLabel} />
				<span className="min-w-0 flex-1 truncate text-md font-medium text-fg">{title}</span>
				{view?.readOnly && <Chip>{t("home.recent.readOnly")}</Chip>}
				<span className="shrink-0 font-mono text-xs text-fg-faint">{shortAgo(session.updatedAt, now)}</span>
			</button>
		</motion.li>
	);
}

/** Example prompts as a plain list: the name of the task, then the prompt it drafts. */
function PromptStarters({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const id = useId();
	return (
		<Section id={id} title={t("home.start.title")}>
			<ul className="-mx-2 flex flex-col">
				{EXAMPLE_PROMPTS.map(prompt => (
					<li key={prompt}>
						<button
							type="button"
							onClick={() => startDraft(path, t(`prompts.${prompt}.text`))}
							title={t(`prompts.${prompt}.text`)}
							className={cn(
								"group flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-md outline-none transition-colors duration-(--dur-fast)",
								"hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring",
								"@min-[32rem]:h-9 @min-[32rem]:flex-row @min-[32rem]:items-center @min-[32rem]:gap-4 @min-[32rem]:py-0",
							)}
						>
							<span className="max-w-full shrink-0 truncate font-medium text-fg @min-[32rem]:w-36">{t(`prompts.${prompt}.label`)}</span>
							<span className="w-full min-w-0 truncate text-fg-muted @min-[32rem]:w-auto @min-[32rem]:flex-1">{t(`prompts.${prompt}.text`)}</span>
							<ArrowRight
								className="hidden size-3.5 shrink-0 @min-[32rem]:block text-fg-faint opacity-0 transition-[opacity,translate] duration-(--dur) ease-(--ease-out-quart) -translate-x-1 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
								aria-hidden
							/>
						</button>
					</li>
				))}
			</ul>
		</Section>
	);
}

function Health({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const id = useId();
	const git = useGit(path);
	const status = git?.status;
	const ci = git?.pr ? ciState(git.pr) : "none";
	return (
		<Section
			id={id}
			title={t("home.health.title")}
			action={<IconButton label={t("home.health.openDiff")} icon={<ArrowRight />} size="sm" onClick={() => useApp.getState().showPane("diff")} />}
		>
			<Loaded
				ready={Boolean(status)}
				placeholder={
					<div className="flex flex-col gap-3 py-1" aria-busy>
						{git?.error ? (
							<p className="text-sm text-err">{git.error}</p>
						) : (
							[0, 1, 2].map(row => <Skeleton key={row} shape="text" width={row === 2 ? "50%" : "80%"} />)
						)}
					</div>
				}
			>
				{status && (
					<div className="flex flex-col gap-2 text-md">
						<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-sm text-fg">
								<GitBranch className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
								<span className="truncate">{status.branch ?? t("home.health.detached")}</span>
							</span>
							{status.totals.files > 0 ? (
								<span className="font-mono text-sm tabular-nums">
									<span className="text-diff-add-text">+{status.totals.additions}</span>{" "}
									<span className="text-diff-del-text">−{status.totals.deletions}</span>
									<span className="sr-only">{t("home.health.lines", { add: status.totals.additions, del: status.totals.deletions })}</span>
								</span>
							) : (
								<span className="text-fg-muted">{t("home.meta.clean")}</span>
							)}
						</p>
						<p className="text-sm text-fg-muted">
							{status.unborn
								? t("home.health.noCommits")
								: !status.upstream
									? t("home.health.noUpstream")
									: status.ahead === 0 && status.behind === 0
										? t("home.health.synced")
										: [
												status.ahead > 0 ? t("home.health.ahead", { count: status.ahead }) : null,
												status.behind > 0 ? t("home.health.behind", { count: status.behind }) : null,
											]
												.filter(Boolean)
												.join(" · ")}
						</p>
						{ci !== "none" && (
							<p className="text-sm">
								<Chip tone={ci === "pass" ? "ok" : ci === "pending" ? "warn" : "err"} dot>
									{t(`home.health.ci.${ci}`)}
								</Chip>
							</p>
						)}
					</div>
				)}
			</Loaded>
		</Section>
	);
}

function NoGit({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const id = useId();
	const [busy, setBusy] = useState(false);
	return (
		<Section id={id} title={t("home.health.title")}>
			<div className="flex flex-col items-start gap-3">
				<p className="text-md text-fg-muted">{t("home.health.noGit")}</p>
				<Button
					size="sm"
					icon={<FolderPlus />}
					loading={busy}
					onClick={() => {
						setBusy(true);
						void initGit(path).finally(() => setBusy(false));
					}}
				>
					{t("home.health.initGit")}
				</Button>
			</div>
		</Section>
	);
}

function Instructions({ path, data }: { path: string; data: [ProjectInstructions, ProjectRule[]] | null }): ReactNode {
	const { t } = useTranslation("projects");
	const id = useId();
	const openSheet = useApp(state => state.openSheet);
	const [instructions, rules] = data ?? [null, null];
	const active = instructions?.files.find(file => file.relPath === instructions.activeRelPath) ?? null;
	const loaded = rules?.filter(rule => rule.enabled).length ?? 0;
	return (
		<Section
			id={id}
			title={t("home.instructions.title")}
			action={
				instructions && (
					<Button size="sm" variant="ghost" onClick={() => openSheet("project-instructions", { projectPath: path })}>
						{active ? t("home.instructions.edit") : t("home.instructions.write")}
					</Button>
				)
			}
		>
			<Loaded
				ready={instructions !== null}
				placeholder={
					<div className="flex flex-col gap-3 py-1" aria-busy>
						{[0, 1].map(row => (
							<Skeleton key={row} shape="text" width={row ? "40%" : "70%"} />
						))}
					</div>
				}
			>
				<div className="flex flex-col gap-1.5">
					<p className="truncate text-md text-fg">
						{active ? (
							<>
								<span className="font-mono text-sm">{active.relPath}</span>
								<span className="text-fg-muted"> · {formatBytes(new TextEncoder().encode(active.content ?? "").length)}</span>
							</>
						) : (
							<span className="text-fg-muted">{t("home.instructions.none")}</span>
						)}
					</p>
					<button
						type="button"
						className="self-start rounded-sm text-sm text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-ring"
						onClick={() => openSheet("project-instructions", { projectPath: path, tab: "rules" })}
					>
						{t("home.instructions.rules", { count: loaded })}
					</button>
				</div>
			</Loaded>
		</Section>
	);
}
