/**
 * Home (DESIGN §4.24): where the app opens, and where the title bar's Home button leads. The mark and the empty chat's
 * question, the prompt box (start a chat in any project with the new chat's choices), then the latest chats across
 * every project, the projects themselves and a glance at plan limits and the last week's estimated API cost. One card
 * (the prompt box); the rest are bare sections on the sheet, over the quiet ping field. From 1080px wide the sections
 * share two columns: chats on the left, projects and usage on the right.
 */
import type { ProjectSummary, SessionSummary } from "@shared/ipc";
import { Folder, FolderMinus, FolderOpen, Plus, PushPin } from "@phosphor-icons/react";
import { type CSSProperties, type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScreenProps } from "@/registry/slots";
import { ChatStatusMark } from "@/shell/ChatStatusMark";
import { chatStatus, chatTitle, shortAgo, useNow, useSessionView } from "@/shell/hooks";
import { sortProjects } from "@/shell/sidebarRows";
import { controllerFor, useApp } from "@/state/app";
import { projectColorValue, useProjectColor } from "@/state/projectColors";
import { Button, Chip, cn, Expand, Mark } from "@/ui";
import { focusRing } from "@/ui/styles";
import { openFolder } from "../projects/actions";
import { HomeComposer } from "./HomeComposer";
import { PingField } from "./PingField";
import { HomeSectionHeader } from "./Section";
import { UsageGlance } from "./UsageGlance";

/** Sheet width from which the sections sit in two columns (matches `@min-[67.5rem]/home`). */
const TWO_COLUMNS_PX = 1080;
const PROJECT_LIMIT = 6;

export function HomeScreen(_props: ScreenProps): ReactNode {
	const { t } = useTranslation("chat");
	const returning = useApp(state => (state.recentSessions?.length ?? 0) > 0 || state.tabs.length > 0);
	const root = useRef<HTMLDivElement>(null);
	const wide = useWiderThan(root, TWO_COLUMNS_PX);
	return (
		<div ref={root} data-surface="sheet" className="@container/home relative flex min-h-0 min-w-0 flex-1 bg-bg">
			<PingField />
			<div className="relative min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-260 px-page pb-12 pt-[clamp(3.5rem,10vh,7.5rem)]">
					<header className="flex flex-col items-center text-center">
						<Mark size={40} />
						<h1 className="mt-card text-2xl font-bold text-fg">{t(returning ? "empty.returning" : "empty.first")}</h1>
					</header>
					<div className="mt-page">
						<HomeComposer />
					</div>
					<div className="mt-16 grid gap-section @min-[67.5rem]/home:grid-cols-[3fr_2fr]">
						<RecentChats limit={wide ? 8 : 6} />
						<div className="flex min-w-0 flex-col gap-section">
							<Projects />
							<UsageGlance />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

/** True while the element is at least `px` wide. */
function useWiderThan(ref: RefObject<HTMLElement | null>, px: number): boolean {
	const [wide, setWide] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? 0) >= px));
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, px]);
	return wide;
}

/** A project's color as an 8px dot beside its name; a hollow ring when it has none. */
function ProjectDot({ path }: { path: string }): ReactNode {
	const color = useProjectColor(path);
	return (
		<span
			aria-hidden
			className={cn("inline-block size-2 shrink-0 rounded-full", !color && "border border-control")}
			style={color ? { background: projectColorValue(color) } : undefined}
		/>
	);
}

// ─── Recent chats ──────────────────────────────────────────────────────────

function RecentChats({ limit }: { limit: number }): ReactNode {
	const { t } = useTranslation("home");
	const id = useId();
	const sessions = useApp(state => state.recentSessions);
	const projects = useApp(state => state.projects);
	const now = useNow();
	const [all, setAll] = useState(false);
	// Chats of folders that are gone can't be opened from here; the sidebar still lists them.
	const shown = useMemo(() => {
		const names = new Map(projects.filter(project => project.exists).map(project => [project.path, project.name]));
		return (sessions ?? []).flatMap(session => {
			const name = names.get(session.cwd);
			return name ? [{ session, projectName: name }] : [];
		});
	}, [sessions, projects]);
	const first = shown.slice(0, limit);
	const rest = shown.slice(limit);
	return (
		<section aria-labelledby={id} className="min-w-0">
			<HomeSectionHeader
				id={id}
				title={t("recent.title")}
				action={rest.length > 0 ? { label: all ? t("recent.fewer") : t("recent.more"), onClick: () => setAll(open => !open), expanded: all } : undefined}
			/>
			{sessions !== null && first.length === 0 ? (
				<p className="flex h-10 items-center text-md text-fg-muted">{t("recent.empty")}</p>
			) : (
				<div className="-mx-2">
					<ul className="flex flex-col">
						{first.map(entry => (
							<RecentRow key={entry.session.file} session={entry.session} projectName={entry.projectName} now={now} />
						))}
					</ul>
					<Expand open={all}>
						<ul className="flex flex-col">
							{rest.map(entry => (
								<RecentRow key={entry.session.file} session={entry.session} projectName={entry.projectName} now={now} />
							))}
						</ul>
					</Expand>
				</div>
			)}
		</section>
	);
}

function RecentRow({ session, projectName, now }: { session: SessionSummary; projectName: string; now: number }): ReactNode {
	const { t } = useTranslation("projects");
	const tab = useApp(state => state.tabs.find(entry => entry.sessionFile === session.file) ?? null);
	const view = useSessionView(controllerFor(tab?.id));
	const status = chatStatus(view);
	const title = chatTitle(view, session.title) ?? session.preview ?? t("overview.recent.untitled");
	return (
		<li>
			<button
				type="button"
				onClick={() => useApp.getState().openSession(session)}
				title={session.preview ?? undefined}
				className={cn(
					"flex h-10 w-full items-center gap-3 rounded-md px-2 text-left transition-colors duration-(--dur-fast) hover:bg-hover",
					focusRing,
				)}
			>
				<ChatStatusMark status={status} label={t(`overview.recent.status.${status}`)} />
				<span className="min-w-0 flex-1 truncate text-md text-fg">{title}</span>
				{view?.readOnly && <Chip>{t("overview.recent.readOnly")}</Chip>}
				<span className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1.5 text-xs text-fg-faint">
					<ProjectDot path={session.cwd} />
					<span className="min-w-0 truncate">{projectName}</span>
					<span aria-hidden>·</span>
					<span className="shrink-0 font-mono">{shortAgo(session.updatedAt, now)}</span>
				</span>
			</button>
		</li>
	);
}

// ─── Projects ──────────────────────────────────────────────────────────────

function Projects(): ReactNode {
	const { t } = useTranslation("home");
	const { t: tp } = useTranslation("projects");
	const id = useId();
	const projects = useApp(state => state.projects);
	const pins = useApp(state => state.prefs?.pinnedProjects);
	const sorted = useMemo(() => sortProjects(projects, pins ?? []), [projects, pins]);
	const [all, setAll] = useState(false);
	const first = sorted.slice(0, PROJECT_LIMIT);
	const rest = sorted.slice(PROJECT_LIMIT);
	return (
		<section aria-labelledby={id} className="min-w-0">
			<HomeSectionHeader
				id={id}
				title={t("projects.title")}
				action={rest.length > 0 ? { label: all ? t("projects.fewer") : t("projects.more", { count: sorted.length }), onClick: () => setAll(open => !open), expanded: all } : undefined}
			/>
			{sorted.length === 0 ? (
				<p className="py-2 text-md text-fg-muted">{tp("overview.noProjects")}</p>
			) : (
				<div className="-mx-2">
					<ul className="flex flex-col">
						{first.map(project => (
							<ProjectRow key={project.path} project={project} pinned={pins?.includes(project.path) ?? false} />
						))}
					</ul>
					<Expand open={all}>
						<ul className="flex flex-col">
							{rest.map(project => (
								<ProjectRow key={project.path} project={project} pinned={pins?.includes(project.path) ?? false} />
							))}
						</ul>
					</Expand>
				</div>
			)}
			<div className="mt-stack flex flex-wrap justify-end gap-toolbar">
				<Button icon={<FolderOpen />} onClick={() => openFolder()}>
					{tp("overview.openFolder")}
				</Button>
				<Button icon={<Plus />} onClick={() => useApp.getState().openSheet("project-new")}>
					{tp("overview.newProject")}
				</Button>
			</div>
		</section>
	);
}

/**
 * A colored project carries its color as a wash behind the row, as in the sidebar but lighter on the sheet: 10% at
 * rest and 16% on hover (`--row-tint` is set on the row).
 */
const tintedRow = "bg-[color-mix(in_oklch,var(--row-tint)_10%,transparent)] hover:bg-[color-mix(in_oklch,var(--row-tint)_16%,transparent)]";

function ProjectRow({ project, pinned }: { project: ProjectSummary; pinned: boolean }): ReactNode {
	const { t } = useTranslation("home");
	const { t: ts } = useTranslation("shell");
	const color = useProjectColor(project.path);
	const now = useNow();
	const meta = project.sessionCount > 0
		? t("projects.meta", { count: project.sessionCount, time: shortAgo(project.lastActivity, now) })
		: t("projects.noChats");
	return (
		<li>
			<button
				type="button"
				onClick={() => useApp.getState().openProject(project.path)}
				title={project.exists ? project.path : ts("sidebar.missingFolder")}
				style={color ? ({ "--row-tint": projectColorValue(color) } as CSSProperties) : undefined}
				className={cn(
					"flex h-10 w-full items-center gap-3 rounded-md px-2 text-left transition-colors duration-(--dur-fast)",
					color ? tintedRow : "hover:bg-hover",
					focusRing,
				)}
			>
				{!project.exists ? (
					<FolderMinus className="size-4.5 shrink-0 text-warn" aria-hidden />
				) : color ? (
					<Folder weight="fill" className="size-4.5 shrink-0" style={{ color: projectColorValue(color) }} aria-hidden />
				) : (
					<Folder className="size-4.5 shrink-0 text-fg-muted" aria-hidden />
				)}
				<span className="flex min-w-0 flex-1 items-center gap-1.5">
					<span className="truncate text-md font-medium text-fg">{project.name}</span>
					{pinned && <PushPin className="size-3 shrink-0 text-fg-faint" aria-label={ts("sidebar.pinProject")} />}
				</span>
				<span className="min-w-0 shrink truncate text-xs text-fg-faint">{meta}</span>
			</button>
		</li>
	);
}
