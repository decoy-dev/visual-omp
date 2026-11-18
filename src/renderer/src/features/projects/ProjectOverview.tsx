/**
 * Project overview (DESIGN §4.3): the project's full name and folder, "Start chat here", live chat board,
 * its instructions and settings, git state, then example prompts. With no project at all it shows the
 * §8.2 empty state.
 */
import type { ApprovalState, ModelRolesState } from "@shared/contracts/config";
import type { ProjectInstructions, ProjectRule } from "@shared/contracts/project";
import { ArrowRight, ChatCenteredDots, Copy, DotsThree, DownloadSimple, FileText, GitBranch, Folder, FolderMinus, FolderOpen, FolderPlus, Plus, PushPin, SlidersHorizontal, WarningCircle, X } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScreenProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import { projectColorValue, useProjectColor } from "@/state/projectColors";
import { openProjectInstructions, openProjectSettings } from "@/state/navigation";
import {
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
	PageHeader,
	PresenceSwap,
	SectionHeader,
	Skeleton,
	toast,
} from "@/ui";
import { initGit } from "../git/actions";
import { ciState } from "../git/format";
import { useGit } from "../git/store";
import { addProject, chooseFolder, openFolder, startDraft } from "./actions";
import { errorText } from "@shared/errors";
import { EXAMPLE_PROMPTS, folderName, formatBytes } from "./format";
import { ProjectBoard } from "./ProjectBoard";

export function ProjectOverview({ projectPath }: ScreenProps): ReactNode {
	const hasProjects = useApp(state => state.projects.length > 0);
	if (!projectPath) return <NoProjects hasProjects={hasProjects} />;
	return <OverviewOf key={projectPath} path={projectPath} />;
}

function NoProjects({ hasProjects }: { hasProjects: boolean }): ReactNode {
	const { t } = useTranslation("projects");
	return (
		<EmptyState
			className="m-auto"
			art={<Mark size={48} />}
			title={t(hasProjects ? "overview.pickProject" : "overview.noProjects")}
			actions={
				<>
					<Button icon={<FolderOpen />} onClick={() => openFolder()}>
						{t("overview.openFolder")}
					</Button>
					<Button icon={<Plus />} onClick={() => useApp.getState().openSheet("project-new")}>
						{t("overview.newProject")}
					</Button>
					<Button variant="primary" icon={<ChatCenteredDots />} onClick={() => chooseFolder()}>
						{t("overview.startIn")}
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

function OverviewOf({ path }: { path: string }): ReactNode {
	const { t } = useTranslation(["projects", "shell"]);
	const project = useApp(state => state.projects.find(entry => entry.path === path) ?? null);
	const sessions = useApp(state => state.sessionsByProject[path]);
	const git = useGit(path);
	const exists = project?.exists ?? true;
	const name = project?.name ?? folderName(path);
	const color = useProjectColor(path);
	const pinned = useApp(state => state.prefs?.pinnedProjects.includes(path) ?? false);
	const notRepo = git !== null && !git.loading && git.repo?.isRepo === false;
	const [sessionsFailed, setSessionsFailed] = useState(false);

	useEffect(() => {
		let live = true;
		if (sessions === undefined) void useApp.getState().loadSessions(path).catch(() => { if (live) setSessionsFailed(true); });
		return () => { live = false; };
	}, [path, sessions]);

	if (!exists) return <MissingFolder path={path} name={name} />;

	return (
		// Layout follows the overview's own width (a size container), so an open sidebar and inspector narrow it correctly.
		<div data-surface="canvas" className="@container/content min-h-0 flex-1 overflow-y-auto bg-bg">
			<div className="mx-auto flex w-full max-w-230 flex-col gap-section px-page pb-16 pt-page">
				<PageHeader
					// The column's gap-section spaces the header; PageHeader's own bottom margin would double it.
					className="mb-0!"
					title={
						<span className="inline-flex min-w-0 items-center gap-2">
							{color ? (
								<Folder weight="fill" className="size-7 shrink-0" style={{ color: projectColorValue(color) }} aria-hidden />
							) : (
								<Folder className="size-7 shrink-0 text-fg-muted" aria-hidden />
							)}
							<span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
							{pinned && <PushPin role="img" className="size-3.5 shrink-0 text-fg-faint" aria-label={t("overview.pinned")} />}
						</span>
					}
					meta={
						<>
							<span className="min-w-0 font-mono text-sm text-fg-muted [overflow-wrap:anywhere]">{path}</span>
							<span className="flex items-center gap-1">
								<IconButton
									size="sm"
									label={t("overview.copyPath")}
									icon={<Copy />}
									onClick={() =>
										void navigator.clipboard.writeText(path).then(
											() => toast({ tone: "ok", message: t("overview.pathCopied") }),
											error => toast({ tone: "err", message: t("overview.copyFailed"), description: errorText(error) }),
										)
									}
								/>
								<IconButton size="sm" label={t("overview.menuReveal")} icon={<FolderOpen />} onClick={() => void window.vomp.invoke("app:showItem", path)} />
							</span>
						</>
					}
					actions={
						<>
							<Button variant="primary" icon={<ChatCenteredDots />} onClick={() => void useApp.getState().newChat(path)}>
								{t("overview.newChat")}
							</Button>
							<ProjectMenu path={path} />
						</>
					}
				/>

				<div className="flex flex-col gap-section">
					<ProjectBoard path={path} sessions={sessions} failed={sessionsFailed} />
					<div className="grid grid-cols-1 items-start gap-page @min-[46rem]/content:grid-cols-[3fr_2fr]">
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
				<IconButton variant="secondary" size="lg" icon={<DotsThree weight="bold" />} label={t("overview.menu")} />
			</MenuTrigger>
			<MenuContent align="end">
				<MenuItem icon={<SlidersHorizontal />} onSelect={() => openProjectSettings(path)}>
					{t("overview.menuSettings")}
				</MenuItem>
				<MenuItem icon={<FileText />} onSelect={() => openProjectInstructions(path)}>
					{t("overview.menuInstructions")}
				</MenuItem>
				<MenuItem icon={<DownloadSimple />} onSelect={() => useApp.getState().openSheet("project-import", { projectPath: path })}>
					{t("overview.menuImport")}
				</MenuItem>
				
				<MenuSeparator />
				<MenuItem icon={<X />} danger onSelect={() => void remove()}>
					{t("overview.menuRemove")}
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
			title={t("overview.missing.title", { name })}
			body={t("overview.missing.body", { path })}
			actions={
				<>
					<Button onClick={() => void locate()}>{t("overview.missing.locate")}</Button>
					<Button
						variant="danger-ghost"
						onClick={() => void window.vomp.invoke("project:remove", path).then(() => useApp.getState().refreshProjects())}
					>
						{t("overview.menuRemove")}
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

/** One label and value in the instructions and settings summary. */
function SummaryRow({ label, children }: { label: string; children: ReactNode }): ReactNode {
	return (
		<div className="grid grid-cols-1 gap-x-card gap-y-1 py-2 @min-[32rem]/content:grid-cols-[7.5rem_minmax(0,1fr)] @min-[32rem]/content:gap-y-0">
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
		<Card className="min-w-0">
			<section aria-labelledby={id} className="min-w-0">
				<SectionHeader id={id} title={t("overview.setup.title")} className="mb-stack" />
				<dl className="flex flex-col">
					<SummaryRow label={t("overview.setup.instructions")}>
						<LoadedValue data={files} failed={t("overview.setup.instructionsFailed")}>
							{() =>
								active ? (
									<span>
										<span className="font-mono text-sm [overflow-wrap:anywhere]">{active.relPath}</span>
										<span className="text-fg-muted"> · {formatBytes(new TextEncoder().encode(active.content ?? "").length)}</span>
									</span>
								) : (
									<span className="text-fg-muted">{t("overview.instructions.none")}</span>
								)
							}
						</LoadedValue>
						<span className="mt-1 block text-sm">
							<LoadedValue data={rules} failed={t("overview.setup.rulesFailed")}>
								{value => (
									<button
										type="button"
										className="rounded-sm text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-ring"
										onClick={() => openProjectInstructions(path, "rules")}
									>
										{t("overview.instructions.rules", { count: value.filter(rule => rule.enabled).length })}
									</button>
								)}
							</LoadedValue>
						</span>
					</SummaryRow>
					<SummaryRow label={t("overview.setup.model")}>
						<LoadedValue data={roles} failed={t("overview.setup.settingFailed")}>
							{value => {
								const role = value.roles.find(entry => entry.id === "default") ?? null;
								return (
									<span>
										{role?.model ? <span className="font-mono text-sm [overflow-wrap:anywhere]">{role.model}</span> : <span className="text-fg-muted">{t("overview.setup.modelAuto")}</span>}
										{role?.source === "project" && <span className="text-fg-muted"> · {t("overview.setup.projectOnly")}</span>}
									</span>
								);
							}}
						</LoadedValue>
					</SummaryRow>
					<SummaryRow label={t("overview.setup.mode")}>
						<LoadedValue data={approval} failed={t("overview.setup.settingFailed")}>
							{value => (
								<span>
									{t(`settings.mode.${value.mode ?? "unknown"}.label`)}
									{value.modeSource === "project" && <span className="text-fg-muted"> · {t("overview.setup.projectOnly")}</span>}
								</span>
							)}
						</LoadedValue>
					</SummaryRow>
				</dl>
				<div className="mt-card flex flex-wrap gap-toolbar">
					<Button size="sm" icon={<FileText />} onClick={() => openProjectInstructions(path)}>
						{files.state === "ready" && !active ? t("overview.instructions.write") : t("overview.instructions.edit")}
					</Button>
					<Button size="sm" icon={<SlidersHorizontal />} onClick={() => openProjectSettings(path)}>
						{t("overview.setup.openSettings")}
					</Button>
				</div>
			</section>
		</Card>
	);
}

function Health({ path }: { path: string }): ReactNode {
	const { t } = useTranslation(["projects", "git"]);
	const id = useId();
	const git = useGit(path);
	const status = git?.status;
	const ci = git?.pr ? ciState(git.pr) : "none";
	const branch = status?.branch ?? (status?.head ? status.head.slice(0, 7) : t("git:branch.detached"));
	return (
		<Card className="min-w-0">
			<section aria-labelledby={id} className="min-w-0">
				<SectionHeader id={id} title={t("overview.health.title")} className="mb-stack" />
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
						<div className="flex flex-col gap-stack py-2">
							<div className="flex min-w-0 items-center gap-2 font-mono text-sm text-fg-muted">
								<GitBranch className="size-4 shrink-0" aria-hidden />
								<span className="min-w-0 text-fg [overflow-wrap:anywhere]">{branch}</span>
							</div>
							<div className="flex flex-wrap items-baseline gap-x-card gap-y-1">
								<p className="text-md font-medium text-fg">
									{status.totals.files === 0 ? t("overview.health.clean") : t("overview.health.filesChanged", { count: status.totals.files })}
								</p>
								{status.totals.files > 0 && (
									<span className="font-mono text-xs tabular-nums">
										<span className="text-diff-add-text" aria-hidden>+{status.totals.additions}</span>{" "}
										<span className="text-diff-del-text" aria-hidden>−{status.totals.deletions}</span>
										<span className="sr-only">{t("git:changes.srLabel", { additions: status.totals.additions, deletions: status.totals.deletions })}</span>
									</span>
								)}
							</div>
							<p className="text-sm text-fg-muted">
								{!status.unborn && status.upstream && <><span className="font-mono [overflow-wrap:anywhere]">{status.upstream}</span> · </>}
								{status.unborn
									? t("overview.health.noCommits")
									: !status.upstream
										? t("overview.health.noUpstream")
										: status.ahead === 0 && status.behind === 0
											? t("overview.health.synced")
											: [
													status.ahead > 0 ? t("overview.health.ahead", { count: status.ahead }) : null,
													status.behind > 0 ? t("overview.health.behind", { count: status.behind }) : null,
												]
													.filter(Boolean)
													.join(" · ")}
							</p>
							<div className="mt-stack flex flex-wrap items-center gap-toolbar">
								{ci !== "none" && (
									<Chip tone={ci === "pass" ? "ok" : ci === "pending" ? "warn" : "err"} dot>
										{t(`overview.health.ci.${ci}`)}
									</Chip>
								)}
								{status.totals.files > 0 && (
									<Button size="sm" icon={<ArrowRight />} onClick={() => useApp.getState().showPane("diff")}>
										{t("overview.health.openDiff")}
									</Button>
								)}
							</div>
						</div>
					)}
				</Loaded>
			</section>
		</Card>
	);
}

function NoGit({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const id = useId();
	const [busy, setBusy] = useState(false);
	return (
		<Card className="min-w-0">
			<section aria-labelledby={id} className="min-w-0">
				<SectionHeader id={id} title={t("overview.health.title")} className="mb-stack" />
				<div className="flex flex-col items-start gap-3 py-2">
					<p className="text-md text-fg-muted">{t("overview.health.noGit")}</p>
					<Button
						size="sm"
						icon={<FolderPlus />}
						loading={busy}
						onClick={() => {
							setBusy(true);
							void initGit(path).finally(() => setBusy(false));
						}}
					>
						{t("overview.health.initGit")}
					</Button>
				</div>
			</section>
		</Card>
	);
}

/** Example prompts as a plain list: the name of the task, then the prompt it drafts. */
function PromptStarters({ path }: { path: string }): ReactNode {
	const { t } = useTranslation("projects");
	const id = useId();
	return (
		<section aria-labelledby={id}>
			<SectionHeader id={id} title={t("overview.start.title")} description={t("overview.start.body")} className="mb-stack" />
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
							<span className="w-full min-w-0 truncate text-sm text-fg-muted @min-[32rem]/content:w-auto @min-[32rem]/content:flex-1">{t(`prompts.${prompt}.text`)}</span>
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
