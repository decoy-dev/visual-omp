/**
 * Command palette (DESIGN §4.10): one search box over every action, chat, project file and setting.
 * Empty query suggests the five most-used actions; no match offers to send the text to omp instead.
 */
import * as RD from "@radix-ui/react-dialog";
import type { SessionSummary } from "@shared/ipc";
import { Command, useCommandState } from "cmdk";
import { CaretRight, ChatCenteredText, FileText, GearSix, type Icon, MagnifyingGlass, PaperPlaneRight } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { type CommandSpec, useCommands } from "../../registry/commands";
import { shortAgo } from "../../shell/hooks";
import { controllerFor, focusedController, focusedTabId, useApp } from "../../state/app";
import { cn, Kbd, toast } from "../../ui";
import { commandContext, runCommand } from "./run";
import { keywordList, rank, rankFiles } from "./search";
import { mostUsed } from "./usage";

/** Suggestions for someone who has not used the palette yet. */
const STARTER_COMMANDS = ["chat.new", "chat.compact", "chat.model", "view.terminal", "app.settings"];
const MOD = window.vomp.platform === "darwin" ? "⌘" : "Ctrl";

let chatCache: SessionSummary[] = [];
const fileCache = new Map<string, string[]>();

async function loadAllChats(): Promise<SessionSummary[]> {
	const projects = await window.vomp.invoke("sessions:projects");
	const lists = await Promise.all(
		projects.filter(project => project.exists).map(project => window.vomp.invoke("sessions:list", project.path).catch(() => [])),
	);
	return lists.flat().sort((a, b) => b.updatedAt - a.updatedAt);
}

function useAllChats(): SessionSummary[] {
	const [chats, setChats] = useState(chatCache);
	useEffect(() => {
		let live = true;
		void loadAllChats().then(list => {
			chatCache = list;
			if (live) setChats(list);
		});
		return () => {
			live = false;
		};
	}, []);
	return chats;
}

/** Project files, fetched once per palette open and only once the user starts typing. */
function useProjectFiles(projectPath: string | null, enabled: boolean): readonly string[] {

	const [files, setFiles] = useState<readonly string[]>([]);
	const requested = useRef<string | null>(null);
	useEffect(() => {
		if (!projectPath) {
			setFiles([]);
			return;
		}
		setFiles(fileCache.get(projectPath) ?? []);
		if (!enabled || requested.current === projectPath) return;
		requested.current = projectPath;
		let live = true;
		void window.vomp
			.invoke("fs:files", projectPath)
			.then(list => {
				fileCache.set(projectPath, list);
				if (live) setFiles(list);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [enabled, projectPath]);
	return files;
}

/** Send the palette text to the focused chat, or start a chat in the current project for it. */
async function askOmp(text: string): Promise<void> {
	let controller = focusedController();
	if (!controller) {
		const tabId = useApp.getState().newChat();
		controller = controllerFor(tabId);
	}
	if (!controller) {
		runCommand("project.new");
		return;
	}
	await controller.send(text);
}

function mentionFile(path: string, projectPath: string): void {
	let tabId = focusedTabId(useApp.getState());
	tabId ??= useApp.getState().newChat(projectPath);
	if (tabId) useComposerDrafts.getState().insert(tabId, `@${path} `);
}

interface RowProps {
	value: string;
	icon: Icon;
	title: string;
	hint?: string | null;
	slash?: string;
	shortcut?: string;
	danger?: boolean;
	/** Replaces the right-hand hints (the ⌘⏎ confirmation prompt). */
	notice?: string | null;
	onSelect(): void;
}

function Row({ value, icon: Icon, title, hint, slash, shortcut, danger, notice, onSelect }: RowProps) {
	return (
		<Command.Item
			value={value}
			onSelect={onSelect}
			className={cn(
				"group flex h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-md text-fg",
				"data-[selected=true]:bg-selected",
				danger && "text-err",
			)}
		>
			<Icon aria-hidden className={cn("size-4 shrink-0", danger ? "text-err" : "text-fg-muted group-data-[selected=true]:text-fg")} />
			<span className="min-w-0 flex-1 truncate">
				<span className="font-medium">{title}</span>
				{hint && <span className="ml-2 text-fg-muted">{hint}</span>}
			</span>
			{notice ? (
				<span role="status" className="shrink-0 font-mono text-xs text-err">
					{notice}
				</span>
			) : (
				<span className="flex shrink-0 items-center gap-2 font-mono text-xs text-fg-faint">
					{slash && <span>{slash}</span>}
					{shortcut && <Kbd>{shortcut}</Kbd>}
				</span>
			)}
		</Command.Item>
	);
}

interface FooterProps {
	dangerValues: ReadonlySet<string>;
}

function Footer({ dangerValues }: FooterProps) {
	const { t } = useTranslation("palette");
	const selected = useCommandState(state => state.value);
	const chat = selected.startsWith("chat:");
	const danger = dangerValues.has(selected);
	return (
		<footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 font-mono text-xs text-fg-faint">
			<span>↑↓ {t("footer.move")}</span>
			<span aria-hidden>·</span>
			<span>
				{danger ? `${MOD}⏎` : "⏎"} {t("footer.run")}
			</span>
			{chat && (
				<>
					<span aria-hidden>·</span>
					<span>
						{MOD}⏎ {t("footer.split")}
					</span>
				</>
			)}
			<span aria-hidden>·</span>
			<span>esc {t("footer.close")}</span>
		</footer>
	);
}

function PaletteBody() {
	const { t } = useTranslation("palette");
	const [query, setQuery] = useState("");
	const [armed, setArmed] = useState<string | null>(null);
	/** ⌘/Ctrl was held for the selection that is about to fire. */
	const modHeld = useRef(false);
	const ctx = commandContext();
	const commands = useCommands();
	const projects = useApp(state => state.projects);
	const chats = useAllChats();
	const typing = query.trim().length > 0;
	const files = useProjectFiles(ctx.projectPath, typing);

	const close = () => useApp.getState().setPaletteOpen(false);

	const available = commands.filter(spec => spec.id !== "app.palette" && (spec.when?.(ctx) ?? true));
	const describe = (spec: CommandSpec) => ({
		text: t(spec.title),
		keywords: [...(spec.keywords ? keywordList(t(spec.keywords)) : []), ...(spec.hint ? [t(spec.hint)] : []), ...(spec.slash ? [spec.slash] : [])],
	});
	const actions = rank(
		available.filter(spec => spec.group !== "settings"),
		query,
		describe,
		typing ? 10 : Number.POSITIVE_INFINITY,
	);
	const settings = rank(
		available.filter(spec => spec.group === "settings"),
		query,
		describe,
		typing ? 6 : Number.POSITIVE_INFINITY,
	);
	const suggested = typing
		? []
		: mostUsed(
				available.map(spec => spec.id),
				STARTER_COMMANDS,
			).flatMap(id => available.find(spec => spec.id === id) ?? []);
	const projectName = (path: string) => projects.find(project => project.path === path)?.name ?? path.split(/[\\/]/).pop() ?? path;
	const chatTitle = (chat: SessionSummary) => chat.title || chat.preview || t("untitledChat");
	const needle = query.trim().toLowerCase();
	// First messages are long; only a literal phrase match there counts, never scattered letters.
	const matchedChats = rank(
		chats,
		query,
		chat => ({
			text: chatTitle(chat),
			keywords: [projectName(chat.cwd), ...(chat.preview?.toLowerCase().includes(needle) ? [chat.preview] : [])],
		}),
		typing ? 6 : 5,
	);
	const matchedFiles = useMemo(
		() => (typing && ctx.projectPath ? rankFiles(files, query, 8) : []),
		[typing, ctx.projectPath, files, query],
	);
	const nothing = typing && actions.length + settings.length + matchedChats.length + matchedFiles.length === 0;
	const dangerValues = new Set(available.filter(spec => spec.danger).flatMap(spec => [`cmd:${spec.id}`, `suggested:${spec.id}`]));
	const now = Date.now();

	const selectCommand = (spec: CommandSpec, value: string) => {
		if (spec.danger && !modHeld.current) {
			setArmed(value);
			return;
		}
		close();
		runCommand(spec, ctx);
	};

	const commandRow = (spec: CommandSpec, prefix: string) => {
		const value = `${prefix}:${spec.id}`;
		return (
			<Row
				key={value}
				value={value}
				icon={spec.icon ?? (spec.group === "settings" ? GearSix : CaretRight)}
				title={t(spec.title)}
				hint={spec.hint ? t(spec.hint) : null}
				slash={spec.slash}
				shortcut={spec.shortcut}
				danger={spec.danger}
				notice={armed === value ? t("confirmDanger", { keys: `${MOD}⏎` }) : null}
				onSelect={() => selectCommand(spec, value)}
			/>
		);
	};

	const groupClass = cn(
		"px-1.5 pb-1.5",
		"**:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:pt-2.5",
		"**:[[cmdk-group-heading]]:text-sm **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-fg-muted",
	);

	return (
		<Command
			label={t("label")}
			shouldFilter={false}
			loop
			vimBindings={false}
			className="flex max-h-[min(560px,70vh)] flex-col"
			onKeyDownCapture={event => {
				if (event.key === "Enter") modHeld.current = event.metaKey || event.ctrlKey;
				else if (event.key !== "Meta" && event.key !== "Control") setArmed(null);
			}}
			onPointerDownCapture={event => {
				modHeld.current = event.metaKey || event.ctrlKey;
			}}
		>
			<div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
				<MagnifyingGlass aria-hidden className="size-4 shrink-0 text-fg-faint" />
				<Command.Input
					value={query}
					onValueChange={next => {
						setQuery(next);
						setArmed(null);
					}}
					placeholder={t("placeholder")}
					className="h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-faint"
				/>
			</div>
			{/* cmdk measures its results into --cmdk-list-height; easing to it lets the panel grow and shrink with the results. */}
			<Command.List className="h-(--cmdk-list-height) max-h-[min(484px,calc(70vh-76px))] min-h-0 overflow-y-auto overscroll-contain transition-[height] duration-(--dur) ease-(--ease-out-quart) scroll-py-2 *:[[cmdk-list-sizer]]:py-1">
				{suggested.length > 0 && (
					<Command.Group heading={t("groups.suggested")} className={groupClass}>
						{suggested.map(spec => commandRow(spec, "suggested"))}
					</Command.Group>
				)}
				{actions.length > 0 && (
					<Command.Group heading={t("groups.actions")} className={groupClass}>
						{actions.map(spec => commandRow(spec, "cmd"))}
					</Command.Group>
				)}
				{matchedChats.length > 0 && (
					<Command.Group heading={t(typing ? "groups.chats" : "groups.recentChats")} className={groupClass}>
						{matchedChats.map(chat => (
							<Row
								key={chat.file}
								value={`chat:${chat.file}`}
								icon={ChatCenteredText}
								title={chatTitle(chat)}
								hint={`${projectName(chat.cwd)} · ${shortAgo(chat.updatedAt, now)}`}
								onSelect={() => {
									close();
									useApp.getState().openSession(chat, { split: modHeld.current });
								}}
							/>
						))}
					</Command.Group>
				)}
				{matchedFiles.length > 0 && ctx.projectPath && (
					<Command.Group heading={t("groups.files")} className={groupClass}>
						{matchedFiles.map(path => (
							<Row
								key={path}
								value={`file:${path}`}
								icon={FileText}
								title={path}
								hint={projectName(ctx.projectPath ?? "")}
								onSelect={() => {
									close();
									mentionFile(path, ctx.projectPath ?? "");
								}}
							/>
						))}
					</Command.Group>
				)}
				{settings.length > 0 && (
					<Command.Group heading={t("groups.settings")} className={groupClass}>
						{settings.map(spec => commandRow(spec, "cmd"))}
					</Command.Group>
				)}
				{nothing && (
					<Command.Group heading={t("groups.noMatches")} className={groupClass}>
						<Row
							value="ask"
							icon={PaperPlaneRight}
							title={t("ask")}
							hint={`“${query.trim()}”`}
							shortcut="⏎"
							onSelect={() => {
								close();
								void askOmp(query.trim()).catch((error: unknown) =>
									toast({ tone: "err", message: error instanceof Error ? error.message : String(error) }),
								);
							}}
						/>
					</Command.Group>
				)}
			</Command.List>
			<Footer dangerValues={dangerValues} />
		</Command>
	);
}

/** Mounted once at the app root; follows `useApp().paletteOpen`. */
export function PaletteHost() {
	const { t } = useTranslation("palette");
	const open = useApp(state => state.paletteOpen);
	return (
		<RD.Root open={open} onOpenChange={next => useApp.getState().setPaletteOpen(next)}>
			<RD.Portal>
				<RD.Overlay className="vo-scrim fixed inset-0 z-(--z-palette) bg-backdrop" />
				<RD.Content
					aria-describedby={undefined}
					className={cn(
						"vo-dialog fixed left-1/2 top-[18vh] z-(--z-palette) w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2",
						"overflow-hidden rounded-lg border border-border bg-overlay text-fg shadow-(--shadow-overlay) outline-none",
					)}
				>
					<RD.Title className="sr-only">{t("label")}</RD.Title>
					<PaletteBody />
				</RD.Content>
			</RD.Portal>
		</RD.Root>
	);
}
