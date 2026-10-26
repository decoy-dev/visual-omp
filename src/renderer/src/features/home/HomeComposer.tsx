/**
 * Home's prompt box (DESIGN §4.24): the composer card without a running chat behind it. The quiet row under the card
 * picks the project folder, the permission level, the model and the thinking level, the same choices a new chat's
 * composer offers. Sending starts a chat in that folder with omp launched on the chosen model and thinking level
 * (`startChat`), then sends the message. The text and attached images wait in the composer drafts under `home`, so
 * they survive leaving Home and restarting the app.
 */
import type { ModelInfo } from "@shared/contracts/config";
import { ArrowUp, Brain, CaretDown, Folder, FolderOpen, FolderPlus, Paperclip, Plus } from "@phosphor-icons/react";
import { AnimatePresence } from "motion/react";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { attachFiles, attachPaths } from "@/chat/composer/attach";
import { AttachmentChip } from "@/chat/composer/Composer";
import { type Attachment, HOME_DRAFT as HOME, useComposerDrafts } from "@/chat/composer/drafts";
import { useApp } from "@/state/app";
import { projectColorValue, useProjectColor } from "@/state/projectColors";
import { sortProjects } from "@/shell/sidebarRows";
import {
	cn,
	Expand,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuTrigger,
	Popover,
	PopoverContent,
	PopoverTrigger,
	toast,
	Tooltip,
} from "@/ui";
import { ProjectColorDot } from "../projects/ProjectColor";
import { chooseFolder, startChat } from "../projects/actions";
import { folderName } from "../projects/format";
import { thinkingChoices, useChatModels } from "../session-tools/model";
import { ModelList, PermissionMenu, rowPicker } from "../session-tools/pickers";
import { THINKING_LEVELS, type ThinkingLevel } from "../session-tools/screen";

const EMPTY: readonly Attachment[] = [];

/** The project's own model and thinking level (its default role), shown until the user picks others. */
interface Defaults {
	path: string;
	model: string | null;
	thinking: ThinkingLevel | null;
}

function useProjectDefaults(projectPath: string | null): Defaults | null {
	const [defaults, setDefaults] = useState<Defaults | null>(null);
	useEffect(() => {
		if (!projectPath) return;
		let live = true;
		window.vomp.invoke("config:roles", projectPath).then(
			state => {
				if (!live) return;
				const role = state.roles.find(entry => entry.id === "default");
				const level = role?.thinking && role.thinking !== "inherit" ? role.thinking : state.defaultThinkingLevel;
				const thinking = THINKING_LEVELS.find(entry => entry === level) ?? null;
				setDefaults({ path: projectPath, model: role?.model ?? null, thinking });
			},
			() => live && setDefaults({ path: projectPath, model: null, thinking: null }),
		);
		return () => {
			live = false;
		};
	}, [projectPath]);
	return defaults?.path === projectPath ? defaults : null;
}

/** What the user picked on Home for one project; a new project starts from its own defaults again. */
interface Choice {
	path: string;
	model: ModelInfo | null;
	thinking: ThinkingLevel | null;
}

export function HomeComposer(): ReactNode {
	const { t } = useTranslation("home");
	const { t: tc } = useTranslation("composer");
	const defaultFolder = useApp(state => state.defaultChatFolder);
	const folder = useComposerDrafts(state => state.homeFolder);
	const projectPath = folder ?? defaultFolder;
	const draft = useComposerDrafts(state => state.drafts[HOME] ?? "");
	const attachments = useComposerDrafts(state => state.attachments[HOME] ?? EMPTY);
	const defaults = useProjectDefaults(projectPath);
	const { models } = useChatModels(projectPath ?? "");
	const [choice, setChoice] = useState<Choice | null>(null);
	const picked = choice?.path === projectPath ? choice : null;
	const [sending, setSending] = useState(false);
	const textarea = useRef<HTMLTextAreaElement>(null);

	// A quick return can reuse Home while its exit animation still has it mounted.
	useEffect(() => {
		useComposerDrafts.getState().visitHome();
		return useApp.subscribe((state, previous) => {
			if (state.view === "home" && previous.view !== "home") {
				useComposerDrafts.getState().visitHome();
				setChoice(null);
			}
		});
	}, []);

	const modelInfo = picked?.model ?? (defaults?.model ? models?.find(model => model.selector === defaults.model) : undefined) ?? undefined;
	const choices = thinkingChoices(modelInfo);
	// Show only a level this chat will start with: the one picked (kept only while the model takes it), else the
	// project's default when the model offers it. Otherwise the button names no level and omp decides.
	const thinking = picked?.thinking ?? (defaults?.thinking && choices.includes(defaults.thinking) ? defaults.thinking : null);
	const canSend = projectPath !== null && !sending && (draft.trim().length > 0 || attachments.length > 0);

	const send = async () => {
		if (!projectPath || !canSend) return;
		const store = useComposerDrafts.getState();
		setSending(true);
		try {
			const started = await store.sendHome(projectPath, ({ projectPath: path, text, images }) =>
				startChat(path, {
					text,
					images,
					model: picked?.model?.selector ?? null,
					thinking: picked?.thinking ?? null,
				}),
			);
			if (started) setChoice(null);
		} finally {
			setSending(false);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		void send();
	};

	// Mentions stay absolute: the draft can move to another project before it is sent.
	const attach = (files: readonly File[]) => {
		if (!projectPath || files.length === 0) return;
		void attachFiles(HOME, null, files).catch((error: unknown) =>
			toast({ tone: "err", message: tc("attach.failed"), description: String(error) }),
		);
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = [...event.clipboardData.files];
		if (files.length === 0) return;
		event.preventDefault();
		attach(files);
	};

	const onDrop = (event: DragEvent<HTMLDivElement>) => {
		if (event.dataTransfer.files.length === 0) return;
		event.preventDefault();
		attach([...event.dataTransfer.files]);
	};

	const pickFiles = async () => {
		if (!projectPath) return;
		const paths = await window.vomp.invoke("composer:pickFiles", projectPath);
		if (paths.length > 0) attachPaths(HOME, null, paths);
		textarea.current?.focus();
	};

	return (
		<div data-tour="composer" className="mx-auto w-full max-w-(--chat-max)">
			<div
				onDragOver={event => {
					if (projectPath && event.dataTransfer.types.includes("Files")) event.preventDefault();
				}}
				onDrop={onDrop}
				// The text box draws no outline of its own, so the card shows the focus ring while it has keyboard focus.
				className="relative rounded-xl border border-border-strong bg-panel shadow-(--shadow-card) transition-colors duration-(--dur-fast) focus-within:border-control-border has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-2 has-[textarea:focus-visible]:outline-ring"
			>
				<Expand open={attachments.length > 0}>
					<ul aria-label={tc("attach.label")} className="relative flex flex-wrap gap-1.5 px-3 pt-3">
						<AnimatePresence initial={false} mode="popLayout">
							{attachments.map(item => (
								<AttachmentChip key={item.path} item={item} onRemove={() => useComposerDrafts.getState().removeAttachment(HOME, item.path)} />
							))}
						</AnimatePresence>
					</ul>
				</Expand>
				{/* Two rows, as in the chat composer: the text box at full width, then ＋ and Send in a quiet toolbar. */}
				<div className="flex flex-col gap-2 p-2">
					<div className="flex px-1 pt-1">
						<textarea
							ref={textarea}
							// The app opens on Home, and the Home button lands here: the box is where typing goes.
							autoFocus
							value={draft}
							rows={1}
							placeholder={projectPath ? tc("placeholder.idle") : t("composer.placeholderNoProject")}
							aria-label={tc("label")}
							onChange={event => useComposerDrafts.getState().setDraft(HOME, event.target.value)}
							onKeyDown={onKeyDown}
							onPaste={onPaste}
							className="field-sizing-content max-h-50 w-full min-w-0 resize-none overflow-y-auto bg-transparent px-0 py-0.5 text-base leading-(--text-base--line-height) text-fg outline-none [scrollbar-gutter:stable] placeholder:text-fg-faint selection:bg-accent/25"
						/>
					</div>
					<div className="flex items-center gap-1">
						<Menu>
							<Tooltip content={t("composer.plusTip")}>
								<MenuTrigger asChild disabled={!projectPath}>
									<button
										type="button"
										aria-label={tc("plus.label")}
										className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 data-[state=open]:bg-selected"
									>
										<Plus className="size-4" aria-hidden />
									</button>
								</MenuTrigger>
							</Tooltip>
							<MenuContent side="bottom" align="start">
								<MenuItem icon={<Paperclip />} onSelect={() => void pickFiles()}>
									{tc("plus.attach")}
								</MenuItem>
							</MenuContent>
						</Menu>
						<Tooltip content={tc("send.tip")} shortcut="↵">
							<button
								type="button"
								aria-label={tc("send.label")}
								disabled={!canSend}
								onClick={() => void send()}
								className="ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-sm bg-accent text-accent-fg shadow-(--shadow-primary) outline-none transition-[background-color,scale,opacity] duration-(--dur-fast) enabled:hover:bg-accent-hover enabled:active:scale-[0.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45"
							>
								<ArrowUp className="size-4" aria-hidden />
							</button>
						</Tooltip>
					</div>
				</div>
			</div>
			{/* The chat's settings before it exists: a quiet row under the card that wraps rather than crowd. */}
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-2">
				<div className="flex min-w-0 flex-wrap items-center gap-1">
					<ProjectPicker
						projectPath={projectPath}
						defaultFolder={defaultFolder}
						onPick={path => {
							useComposerDrafts.getState().setHomeFolder(path);
							setChoice(null);
						}}
					/>
					{projectPath && <PermissionMenu projectPath={projectPath} />}
				</div>
				{projectPath && (
					<div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
						<ModelPicker
							projectPath={projectPath}
							current={modelInfo ?? null}
							fallbackName={defaults?.model ?? null}
							onPick={model => {
								// A level the new model can't take is dropped, so the button never shows a choice omp won't get.
								const keep = picked?.thinking && thinkingChoices(model).includes(picked.thinking) ? picked.thinking : null;
								setChoice({ path: projectPath, model, thinking: keep });
							}}
						/>
						<ThinkingPicker
							level={thinking}
							choices={choices}
							known={modelInfo !== undefined}
							onPick={level => setChoice({ path: projectPath, model: picked?.model ?? null, thinking: level })}
						/>
					</div>
				)}
			</div>
		</div>
	);
}

/** The folder omp will work in: projects pinned first, then by activity, with their colors; or add a folder. */
function ProjectPicker({ projectPath, defaultFolder, onPick }: { projectPath: string | null; defaultFolder: string | null; onPick(path: string): void }): ReactNode {
	const { t } = useTranslation("home");
	const projects = useApp(state => state.projects);
	const pins = useApp(state => state.prefs?.pinnedProjects);
	const color = useProjectColor(projectPath ?? "");
	const folders = defaultFolder && !projects.some(project => project.path === defaultFolder)
		? [...projects, { path: defaultFolder, name: folderName(defaultFolder), sessionCount: 0, lastActivity: 0, exists: true }]
		: projects;
	const name = folders.find(project => project.path === projectPath)?.name ?? (projectPath ? folderName(projectPath) : null);
	return (
		<Menu>
			<Tooltip content={t("composer.project.tip")}>
				<MenuTrigger asChild>
					<button
						type="button"
						aria-label={name ? t("composer.project.aria", { name }) : t("composer.project.choose")}
						className={cn(rowPicker, "h-7 min-w-0 max-w-56", !name && "text-fg-faint")}
					>
						{color ? (
							<Folder weight="fill" className="size-3.5 shrink-0" style={{ color: projectColorValue(color) }} aria-hidden />
						) : (
							<Folder className="size-3.5 shrink-0" aria-hidden />
						)}
						<span className="truncate">{name ?? t("composer.project.choose")}</span>
						<CaretDown className="size-3 shrink-0" aria-hidden />
					</button>
				</MenuTrigger>
			</Tooltip>
			<MenuContent side="bottom" align="start" className="max-h-96 w-72 overflow-y-auto">
				{folders.length > 0 && (
					<>
						<MenuLabel>{t("composer.project.title")}</MenuLabel>
						<MenuRadioGroup value={projectPath ?? ""} onValueChange={onPick}>
							{sortProjects(folders, pins ?? []).map(project => (
								<MenuRadioItem key={project.path} value={project.path} disabled={!project.exists}>
									<span className="flex min-w-0 items-center gap-2">
										<ProjectPickerDot path={project.path} />
										<span className="truncate">{project.name}</span>
									</span>
								</MenuRadioItem>
							))}
						</MenuRadioGroup>
						<MenuSeparator />
					</>
				)}
				<MenuItem icon={<FolderOpen />} onSelect={() => chooseFolder({ purpose: "pick", currentPath: projectPath, onPick })}>
					{t("composer.project.open")}
				</MenuItem>
				<MenuItem icon={<FolderPlus />} onSelect={() => useApp.getState().openSheet("project-new")}>
					{t("composer.project.create")}
				</MenuItem>
			</MenuContent>
		</Menu>
	);
}

function ProjectPickerDot({ path }: { path: string }): ReactNode {
	return <ProjectColorDot color={useProjectColor(path)} />;
}

interface ModelPickerProps {
	projectPath: string;
	current: ModelInfo | null;
	/** The project's default model as configured, shown when omp's list doesn't name it. */
	fallbackName: string | null;
	onPick(model: ModelInfo): void;
}

function ModelPicker({ projectPath, current, fallbackName, onPick }: ModelPickerProps): ReactNode {
	const { t } = useTranslation("session");
	const [open, setOpen] = useState(false);
	const name = current?.name ?? fallbackName ?? t("model.none");
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip content={t("model.aria", { name })}>
				<PopoverTrigger asChild>
					<button type="button" aria-label={t("model.aria", { name })} className={cn(rowPicker, "h-7 min-w-0 max-w-44 shrink-0")}>
						<span className="truncate">{name}</span>
						<CaretDown className="size-3 shrink-0" aria-hidden />
					</button>
				</PopoverTrigger>
			</Tooltip>
			<PopoverContent side="bottom" align="end" width={340} sideOffset={6} className="p-menu">
				<ModelList
					projectPath={projectPath}
					current={current}
					session={null}
					onDone={() => setOpen(false)}
					onPick={async model => {
						onPick(model);
						return true;
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

interface ThinkingPickerProps {
	level: ThinkingLevel | null;
	choices: readonly ThinkingLevel[];
	/** The model is known, so an empty `choices` means it has no thinking levels. */
	known: boolean;
	onPick(level: ThinkingLevel): void;
}

function ThinkingPicker({ level, choices, known, onPick }: ThinkingPickerProps): ReactNode {
	const { t } = useTranslation("session");
	const unsupported = known && choices.length === 0;
	const label = t("thinking.aria", { level: level ? t(`thinking.levels.${level}.label`) : t("common.unknown") });
	return (
		<Menu>
			<Tooltip content={unsupported ? t("thinking.unsupported") : label}>
				<MenuTrigger asChild disabled={unsupported || choices.length === 0}>
					<button type="button" aria-label={label} className={cn(rowPicker, "h-7 shrink-0")}>
						<Brain className="size-3.5 shrink-0" aria-hidden />
						<span>{level && !unsupported ? t(`thinking.levels.${level}.label`) : t("thinking.title")}</span>
						<CaretDown className="size-3 shrink-0" aria-hidden />
					</button>
				</MenuTrigger>
			</Tooltip>
			<MenuContent side="bottom" align="end" className="w-72">
				<MenuLabel>{t("thinking.title")}</MenuLabel>
				<MenuRadioGroup value={level ?? ""} onValueChange={value => onPick(value as ThinkingLevel)}>
					{choices.map(choice => (
						<MenuRadioItem key={choice} value={choice} description={t(`thinking.levels.${choice}.description`)}>
							{t(`thinking.levels.${choice}.label`)}
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
			</MenuContent>
		</Menu>
	);
}
