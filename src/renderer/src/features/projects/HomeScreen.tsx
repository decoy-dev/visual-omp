/**
 * Project home dashboard (DESIGN §4.3): header with this week's activity, recent chats, quick-start
 * prompts, git health and project instructions. With no project at all it shows the §8.2 empty state.
 */
import type { ProjectInstructions, ProjectRule } from "@shared/contracts/project";
import type { ProjectWeekStats } from "@shared/contracts/usage";
import type { SessionSummary } from "@shared/ipc";
import {
	ArrowRight,
	FileText,
	FolderOpen,
	FolderPlus,
	FolderX,
	GitBranch,
	Import,
	MessageSquarePlus,
	Plus,
	Settings2,
	SlidersHorizontal,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScreenProps } from "@/registry/slots";
import { chatStatus, chatTitle, shortAgo, useNow, useSessionView } from "@/shell/hooks";
import { controllerFor, useApp } from "@/state/app";
import {
	BracketLabel,
	Button,
	Card,
	Chip,
	cn,
	EmptyState,
	IconButton,
	Mark,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	PulseDot,
	Skeleton,
	StatusDot,
	toast,
} from "@/ui";
import { initGit } from "../git/actions";
import { ciState } from "../git/format";
import { useGit } from "../git/store";
import { addProject, errorText, openFolder, startDraft } from "./actions";
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
					<Button icon={<FolderOpen />} onClick={() => void openFolder()}>
						{t("home.openFolder")}
					</Button>
					<Button variant="primary" icon={<Plus />} onClick={() => useApp.getState().openSheet("project-new")}>
						{t("home.newProject")}
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
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex max-w-[880px] flex-col gap-4 p-6">
				<header className="flex items-start gap-4">
					<div className="min-w-0 flex-1">
						<BracketLabel>{t("home.eyebrow")}</BracketLabel>
						<h1 className="mt-1 truncate text-[28px] font-bold leading-tight tracking-[-0.02em] text-fg" title={path}>
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
								<>
									<span>
										<span className="font-mono tabular-nums">{week.chats}</span> {t("home.meta.chatsWeek", { count: week.chats })}
									</span>
									<span aria-hidden>·</span>
									<span>
										<span className="font-mono tabular-nums">{formatUsd(week.costUsd)}</span> {t("home.meta.costWeek")}
									</span>
								</>
							) : (
								<Skeleton shape="text" width={180} />
							)}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button variant="primary" icon={<MessageSquarePlus />} onClick={() => useApp.getState().newChat(path)}>
							{t("home.newChat")}
						</Button>
						<ProjectMenu path={path} />
					</div>
				</header>

				<RecentChats path={path} sessions={visible} />
				<StartSomething path={path} expanded={visible !== undefined && visible.length === 0} />

				<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
					{notRepo ? <NoGitCard path={path} /> : <HealthCard path={path} />}
					<InstructionsCard path={path} data={instructions} />
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
				<IconButton variant="secondary" size="lg" icon={<Settings2 />} label={t("home.menu")} />
			</MenuTrigger>
			<MenuContent align="end">
				<MenuItem icon={<SlidersHorizontal />} onSelect={() => openSheet("project-settings", { projectPath: path })}>
					{t("home.menuSettings")}
				</MenuItem>
				<MenuItem icon={<FileText />} onSelect={() => openSheet("project-instructions", { projectPath: path })}>
					{t("home.menuInstructions")}
				</MenuItem>
				<MenuItem icon={<Import />} onSelect={() => openSheet("project-import", { projectPath: path })}>
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
			icon={<FolderX />}
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

function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }): ReactNode {
	return (
		<div className="flex h-11 items-center gap-2 px-4">
			<h2 className="flex-1 text-md font-semibold text-fg">{children}</h2>
			{action}
		</div>
	);
}

function RecentChats({ path, sessions }: { path: string; sessions: SessionSummary[] | undefined }): ReactNode {
	const { t } = useTranslation("projects");
	const now = useNow();
	const [all, setAll] = useState(false);
	const shown = all ? sessions : sessions?.slice(0, RECENT_LIMIT);
	const more = (sessions?.length ?? 0) > RECENT_LIMIT;
	return (
		<Card padding="none" aria-labelledby="home-recent">
			<CardTitle
				action={
					more && (
						<Button variant="ghost" size="sm" iconRight={<ArrowRight />} onClick={() => setAll(value => !value)} aria-expanded={all}>
							{all ? t("home.recent.fewer") : t("home.recent.all", { count: sessions?.length ?? 0 })}
						</Button>
					)
				}
			>
				<span id="home-recent">{t("home.recent.title")}</span>
			</CardTitle>
			{shown === undefined ? (
				<div className="flex flex-col gap-3 px-4 pb-4" aria-busy>
					{[0, 1, 2].map(row => (
						<Skeleton key={row} height={20} />
					))}
				</div>
			) : shown.length === 0 ? (
				<div className="flex items-center gap-3 border-t border-border px-4 py-4">
					<p className="flex-1 text-md text-fg-muted">{t("home.recent.empty")}</p>
					<Button size="sm" icon={<Plus />} onClick={() => useApp.getState().newChat(path)}>
						{t("home.newChat")}
					</Button>
				</div>
			) : (
				<ul className="border-t border-border p-1">
					{shown.map(session => (
						<RecentRow key={session.file} session={session} now={now} />
					))}
				</ul>
			)}
		</Card>
	);
}

function RecentRow({ session, now }: { session: SessionSummary; now: number }): ReactNode {
	const { t } = useTranslation("projects");
	const tab = useApp(state => state.tabs.find(entry => entry.sessionFile === session.file) ?? null);
	const view = useSessionView(controllerFor(tab?.id));
	const status = chatStatus(view);
	const title = chatTitle(view, session.title) ?? session.preview ?? t("home.recent.untitled");
	const statusLabel = t(`home.recent.status.${status}`);
	return (
		<li>
			<button
				type="button"
				onClick={() => useApp.getState().openSession(session)}
				title={session.preview ?? undefined}
				className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
			>
				{status === "working" ? (
					<PulseDot label={statusLabel} />
				) : (
					<StatusDot status={status === "needsInput" ? "warn" : status === "live" ? "ok" : "idle"} label={statusLabel} />
				)}
				<span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{title}</span>
				{view?.readOnly && <Chip>{t("home.recent.readOnly")}</Chip>}
				<span className="shrink-0 font-mono text-xs text-fg-faint">{shortAgo(session.updatedAt, now)}</span>
			</button>
		</li>
	);
}

function StartSomething({ path, expanded }: { path: string; expanded: boolean }): ReactNode {
	const { t } = useTranslation("projects");
	return (
		<Card padding="none">
			<CardTitle>{t("home.start.title")}</CardTitle>
			<div className={cn("grid gap-2 px-4 pb-4", expanded ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2 sm:grid-cols-3")}>
				{EXAMPLE_PROMPTS.map(({ id, icon: Icon }) => (
					<button
						key={id}
						type="button"
						onClick={() => startDraft(path, t(`prompts.${id}.text`))}
						title={t(`prompts.${id}.text`)}
						className={cn(
							"group flex items-center gap-2.5 rounded-lg border border-border bg-panel text-left outline-none",
							"transition-[translate,background-color,box-shadow] duration-(--dur-fast) ease-(--ease-out)",
							"hover:-translate-y-px hover:bg-hover hover:shadow-(--shadow-card) focus-visible:outline-2 focus-visible:outline-ring",
							"motion-reduce:hover:translate-y-0",
							expanded ? "items-start p-3" : "h-10 px-3",
						)}
					>
						<Icon className={cn("size-4 shrink-0 text-accent", expanded && "mt-0.5")} aria-hidden />
						<span className="min-w-0">
							<span className="block truncate text-md font-medium text-fg">{t(`prompts.${id}.label`)}</span>
							{expanded && <span className="mt-0.5 line-clamp-2 block text-sm text-fg-muted">{t(`prompts.${id}.text`)}</span>}
						</span>
					</button>
				))}
			</div>
		</Card>
	);
}

function HealthCard({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const git = useGit(path);
	const status = git?.status;
	const ci = git?.pr ? ciState(git.pr) : "none";
	return (
		<Card padding="none" className="min-h-[120px]">
			<CardTitle
				action={<IconButton label={t("home.health.openDiff")} icon={<ArrowRight />} size="sm" onClick={() => useApp.getState().showPane("diff")} />}
			>
				{t("home.health.title")}
			</CardTitle>
			{!status ? (
				<div className="flex flex-col gap-3 px-4 pb-4" aria-busy>
					{git?.error ? (
						<p className="text-sm text-err">{git.error}</p>
					) : (
						[0, 1, 2].map(row => <Skeleton key={row} shape="text" width={row === 2 ? "50%" : "80%"} />)
					)}
				</div>
			) : (
				<div className="flex flex-col gap-2 px-4 pb-4 text-md">
					<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<span className="inline-flex items-center gap-1.5 font-mono text-sm text-fg">
							<GitBranch className="size-3.5 text-fg-muted" aria-hidden />
							{status.branch ?? t("home.health.detached")}
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
		</Card>
	);
}

function NoGitCard({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const [busy, setBusy] = useState(false);
	return (
		<Card padding="none" className="flex min-h-[120px] flex-col border-dashed bg-transparent">
			<CardTitle>{t("home.health.title")}</CardTitle>
			<div className="flex flex-1 flex-col items-start gap-3 px-4 pb-4">
				<p className="text-md text-fg-muted">{t("home.health.noGit")}</p>
				<Button
					variant="ghost"
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
		</Card>
	);
}

function InstructionsCard({ path, data }: { path: string; data: [ProjectInstructions, ProjectRule[]] | null }): ReactNode {
	const { t } = useTranslation("projects");
	const openSheet = useApp(state => state.openSheet);
	const [instructions, rules] = data ?? [null, null];
	const active = instructions?.files.find(file => file.relPath === instructions.activeRelPath) ?? null;
	const loaded = rules?.filter(rule => rule.enabled).length ?? 0;
	return (
		<Card padding="none" className="min-h-[120px]">
			<CardTitle>{t("home.instructions.title")}</CardTitle>
			{!instructions ? (
				<div className="flex flex-col gap-3 px-4 pb-4" aria-busy>
					{[0, 1].map(row => (
						<Skeleton key={row} shape="text" width={row ? "40%" : "70%"} />
					))}
				</div>
			) : (
				<div className="flex flex-col gap-2 px-4 pb-4">
					<div className="flex items-center gap-2">
						<p className="min-w-0 flex-1 truncate text-md text-fg">
							{active ? (
								<>
									<span className="font-mono text-sm">{active.relPath}</span>
									<span className="text-fg-muted"> · {formatBytes(new TextEncoder().encode(active.content ?? "").length)}</span>
								</>
							) : (
								<span className="text-fg-muted">{t("home.instructions.none")}</span>
							)}
						</p>
						<Button size="sm" onClick={() => openSheet("project-instructions", { projectPath: path })}>
							{active ? t("home.instructions.edit") : t("home.instructions.write")}
						</Button>
					</div>
					<div className="flex items-center gap-2">
						<p className="min-w-0 flex-1 truncate text-sm text-fg-muted">{t("home.instructions.rules", { count: loaded })}</p>
						<Button size="sm" variant="ghost" onClick={() => openSheet("project-instructions", { projectPath: path, tab: "rules" })}>
							{t("home.instructions.view")}
						</Button>
					</div>
				</div>
			)}
		</Card>
	);
}
