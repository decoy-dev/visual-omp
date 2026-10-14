/**
 * Project overview (DESIGN §4.3): the project's full name and folder, "Start chat here", recent chats,
 * its instructions and settings, git state, then example prompts. With no project at all it shows the
 * §8.2 empty state.
 */
import type { ApprovalState, ModelRolesState } from "@shared/contracts/config";
import type { ProjectInstructions, ProjectRule } from "@shared/contracts/project";
import type { SessionSummary } from "@shared/ipc";
import { ArrowRight, ChatCenteredDots, Copy, DotsThree, DownloadSimple, FileText, FolderMinus, FolderOpen, FolderPlus, Plus, SlidersHorizontal, WarningCircle, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, type Ref, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScreenProps } from "@/registry/slots";
import { ChatStatusMark } from "@/shell/ChatStatusMark";
import { chatStatus, chatTitle, shortAgo, useNow, useSessionView } from "@/shell/hooks";
import { controllerFor, useApp } from "@/state/app";
import { openProjectInstructions, openProjectSettings } from "@/state/navigation";
import {
	Button,
	Chip,
	cn,
	EmptyState,
	Expand,
	IconButton,
	Mark,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	PageHeader,
	PresenceSwap,
	SectionHeader,
	Skeleton,
	spring,
	toast,
} from "@/ui";
import { initGit } from "../git/actions";
import { ciState } from "../git/format";
import { useGit } from "../git/store";
import { addProject, chooseFolder, errorText, openFolder, startDraft } from "./actions";
import { EXAMPLE_PROMPTS, folderName, formatBytes } from "./format";

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

type Loadable<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed" };

/** Loads `load(path)` once per path. `load` must keep its identity across renders. */
function useLoaded<T>(path: string, load: (path: string) => Promise<T>): Loadable<T> {
	const [result, setResult] = useState<Loadable<T>>({ state: "loading" });
	useEffect(() => {
		let live = true;
		setResult({ state: "loading" });
		load(path).then(
			value => live && setResult({ state: "ready", value }),
			() => live && setResult({ state: "failed" }),
		);
		return () => {
			live = false;
		};
	}, [path, load]);
	return result;
}

// Separate reads, so one failure leaves the other summaries readable.
const loadInstructions = (path: string) => window.vomp.invoke("project:instructions", path);
const loadRules = (path: string) => window.vomp.invoke("project:rules", path);
const loadRoles = (path: string) => window.vomp.invoke("config:roles", path);
const loadApproval = (path: string) => window.vomp.invoke("config:approval", path);

/** A loaded value: a skeleton while loading, a plain "couldn't read" line after a failure. */
function LoadedValue<T>({ data, failed, children }: { data: Loadable<T>; failed: string; children(value: T): ReactNode }): ReactNode {
	return (
		<PresenceSwap swapKey={data.state} mode="popLayout">
			{data.state === "ready" ? (
				children(data.value)
			) : data.state === "failed" ? (
				<span className="inline-flex items-center gap-1.5 text-fg-muted">
					<WarningCircle className="size-3.5 shrink-0 text-warn" aria-hidden />
					{failed}
				</span>
			) : (
				<Skeleton shape="text" width="60%" />
			)}
		</PresenceSwap>
	);
}

function ProjectHome({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const project = useApp(state => state.projects.find(entry => entry.path === path) ?? null);
	const sessions = useApp(state => state.sessionsByProject[path]);
	const git = useGit(path);
	const exists = project?.exists ?? true;
	const name = project?.name ?? folderName(path);
	const notRepo = git !== null && !git.loading && git.repo?.isRepo === false;

	useEffect(() => {
		if (sessions === undefined) void useApp.getState().loadSessions(path);
	}, [path, sessions]);

	if (!exists) return <MissingFolder path={path} name={name} />;

	return (
		// Layout follows the overview's own width (a size container), so an open sidebar and inspector narrow it correctly.
		<div className="@container/content min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto w-full max-w-230 px-page pb-16 pt-page">
				<PageHeader
					title={name}
					meta={
						<>
							<span className="min-w-0 font-mono text-sm text-fg-muted [overflow-wrap:anywhere]">{path}</span>
							<span className="flex items-center gap-1">
								<IconButton
									size="sm"
									label={t("home.copyPath")}
									icon={<Copy />}
									onClick={() =>
										void navigator.clipboard.writeText(path).then(
											() => toast({ tone: "ok", message: t("home.pathCopied") }),
											error => toast({ tone: "err", message: t("home.copyFailed"), description: errorText(error) }),
										)
									}
								/>
								<IconButton size="sm" label={t("home.menuReveal")} icon={<FolderOpen />} onClick={() => void window.vomp.invoke("app:showItem", path)} />
							</span>
						</>
					}
					actions={
						<>
							<Button variant="primary" icon={<ChatCenteredDots />} onClick={() => void useApp.getState().newChat(path)}>
								{t("home.newChat")}
							</Button>
							<ProjectMenu path={path} />
						</>
					}
				/>

				<div className="flex flex-col gap-section">
					<RecentChats sessions={sessions?.filter(session => !session.archived)} />
					<div className="grid grid-cols-1 gap-section @min-[46rem]/content:grid-cols-2">
						<ProjectSetup path={path} />
						{notRepo ? <NoGit path={path} /> : <Health path={path} />}
					</div>
					<PromptStarters path={path} />
				</div>
			</div>
		</div>
	);
}

function ProjectMenu({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
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
				<IconButton variant="secondary" size="lg" icon={<DotsThree weight="bold" />} label={t("home.menu")} />
			</MenuTrigger>
			<MenuContent align="end">
				<MenuItem icon={<SlidersHorizontal />} onSelect={() => openProjectSettings(path)}>
					{t("home.menuSettings")}
				</MenuItem>
				<MenuItem icon={<FileText />} onSelect={() => openProjectInstructions(path)}>
					{t("home.menuInstructions")}
				</MenuItem>
				<MenuItem icon={<DownloadSimple />} onSelect={() => useApp.getState().openSheet("project-import", { projectPath: path })}>
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
		<section aria-labelledby={id}>
			<SectionHeader
				id={id}
				title={t("home.recent.title")}
				className="mb-2"
				actions={
					rest.length > 0 && (
						<Button variant="ghost" size="sm" onClick={() => setAll(value => !value)} aria-expanded={all}>
							{all ? t("home.recent.fewer") : t("home.recent.all", { count: sessions?.length ?? 0 })}
						</Button>
					)
				}
			/>
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
		</section>
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

/** One label and value in the instructions and settings summary. */
function SummaryRow({ label, children }: { label: string; children: ReactNode }): ReactNode {
	return (
		<div className="flex flex-col gap-1 py-2">
			<dt className="text-sm text-fg-muted">{label}</dt>
			<dd className="min-w-0 text-md text-fg [overflow-wrap:anywhere]">{children}</dd>
		</div>
	);
}

/** What omp reads and how it behaves in this project: instructions, rules, model and permission mode. */
function ProjectSetup({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const id = useId();
	const files = useLoaded<ProjectInstructions>(path, loadInstructions);
	const rules = useLoaded<ProjectRule[]>(path, loadRules);
	const roles = useLoaded<ModelRolesState>(path, loadRoles);
	const approval = useLoaded<ApprovalState>(path, loadApproval);
	const active = files.state === "ready" ? (files.value.files.find(file => file.relPath === files.value.activeRelPath) ?? null) : null;
	return (
		<section aria-labelledby={id}>
			<SectionHeader id={id} title={t("home.setup.title")} className="mb-2" />
			<dl className="flex flex-col">
				<SummaryRow label={t("home.setup.instructions")}>
					<LoadedValue data={files} failed={t("home.setup.instructionsFailed")}>
						{() =>
							active ? (
								<span>
									<span className="font-mono text-sm">{active.relPath}</span>
									<span className="text-fg-muted"> · {formatBytes(new TextEncoder().encode(active.content ?? "").length)}</span>
								</span>
							) : (
								<span className="text-fg-muted">{t("home.instructions.none")}</span>
							)
						}
					</LoadedValue>
					<span className="mt-1 block text-sm">
						<LoadedValue data={rules} failed={t("home.setup.rulesFailed")}>
							{value => (
								<button
									type="button"
									className="rounded-sm text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-ring"
									onClick={() => openProjectInstructions(path, "rules")}
								>
									{t("home.instructions.rules", { count: value.filter(rule => rule.enabled).length })}
								</button>
							)}
						</LoadedValue>
					</span>
				</SummaryRow>
				<SummaryRow label={t("home.setup.model")}>
					<LoadedValue data={roles} failed={t("home.setup.settingFailed")}>
						{value => {
							const role = value.roles.find(entry => entry.id === "default") ?? null;
							return (
								<span>
									{role?.model ? <span className="font-mono text-sm">{role.model}</span> : <span className="text-fg-muted">{t("home.setup.modelAuto")}</span>}
									{role?.source === "project" && <span className="text-fg-muted"> · {t("home.setup.projectOnly")}</span>}
								</span>
							);
						}}
					</LoadedValue>
				</SummaryRow>
				<SummaryRow label={t("home.setup.mode")}>
					<LoadedValue data={approval} failed={t("home.setup.settingFailed")}>
						{value => (
							<span>
								{t(`settings.mode.${value.mode}.label`)}
								{value.modeSource === "project" && <span className="text-fg-muted"> · {t("home.setup.projectOnly")}</span>}
							</span>
						)}
					</LoadedValue>
				</SummaryRow>
			</dl>
			<div className="mt-3 flex flex-wrap gap-2">
				<Button size="sm" icon={<FileText />} onClick={() => openProjectInstructions(path)}>
					{files.state === "ready" && !active ? t("home.instructions.write") : t("home.instructions.edit")}
				</Button>
				<Button size="sm" icon={<SlidersHorizontal />} onClick={() => openProjectSettings(path)}>
					{t("home.setup.openSettings")}
				</Button>
			</div>
		</section>
	);
}

function Health({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const id = useId();
	const git = useGit(path);
	const status = git?.status;
	const ci = git?.pr ? ciState(git.pr) : "none";
	return (
		<section aria-labelledby={id}>
			<SectionHeader id={id} title={t("home.health.title")} className="mb-2" />
			<Loaded
				ready={Boolean(status)}
				placeholder={
					<div className="flex flex-col gap-3 py-2" aria-busy>
						{git?.error ? (
							<p className="text-sm text-err">{git.error}</p>
						) : (
							[0, 1, 2].map(row => <Skeleton key={row} shape="text" width={row === 2 ? "50%" : "80%"} />)
						)}
					</div>
				}
			>
				{status && (
					// The branch and line counts live in the status bar; this section states where the work stands and offers the review.
					<div className="flex flex-col gap-2 py-2 text-md">
						{status.totals.files === 0 && <p className="text-fg-muted">{t("home.health.clean")}</p>}
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
						{status.totals.files > 0 && (
							<div className="mt-1">
								<Button size="sm" icon={<ArrowRight />} onClick={() => useApp.getState().showPane("diff")}>
									{t("home.health.openDiff")}
								</Button>
							</div>
						)}
					</div>
				)}
			</Loaded>
		</section>
	);
}

function NoGit({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const id = useId();
	const [busy, setBusy] = useState(false);
	return (
		<section aria-labelledby={id}>
			<SectionHeader id={id} title={t("home.health.title")} className="mb-2" />
			<div className="flex flex-col items-start gap-3 py-2">
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
		</section>
	);
}

/** Example prompts as a plain list: the name of the task, then the prompt it drafts. */
function PromptStarters({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const id = useId();
	return (
		<section aria-labelledby={id}>
			<SectionHeader id={id} title={t("home.start.title")} description={t("home.start.body")} className="mb-2" />
			<ul className="-mx-2 flex flex-col">
				{EXAMPLE_PROMPTS.map(prompt => (
					<li key={prompt}>
						<button
							type="button"
							onClick={() => void startDraft(path, t(`prompts.${prompt}.text`))}
							title={t(`prompts.${prompt}.text`)}
							className={cn(
								"group flex w-full flex-col items-start gap-1 rounded-md px-2 py-2 text-left text-md outline-none transition-colors duration-(--dur-fast)",
								"hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring",
								"@min-[32rem]/content:h-9 @min-[32rem]/content:flex-row @min-[32rem]/content:items-center @min-[32rem]/content:gap-4 @min-[32rem]/content:py-0",
							)}
						>
							<span className="max-w-full shrink-0 truncate font-medium text-fg @min-[32rem]/content:w-36">{t(`prompts.${prompt}.label`)}</span>
							<span className="w-full min-w-0 truncate text-fg-muted @min-[32rem]/content:w-auto @min-[32rem]/content:flex-1">{t(`prompts.${prompt}.text`)}</span>
							<ArrowRight
								className="hidden size-3.5 shrink-0 -translate-x-1 text-fg-faint opacity-0 transition-[opacity,translate] duration-(--dur) ease-(--ease-out-quart) group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 @min-[32rem]/content:block"
								aria-hidden
							/>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
