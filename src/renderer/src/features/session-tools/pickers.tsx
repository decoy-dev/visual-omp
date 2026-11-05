/**
 * Pickers in the quiet row under the composer card (DESIGN §3.6): the permission button with its work
 * modes, the model button and the thinking button. Each change goes through omp and is confirmed from
 * omp's own state. All of them keep their words; the row wraps when the column is narrow, the model name
 * truncates at the button's max width, and the permission text wraps inside its button.
 */
import type { ApprovalMode, ModelInfo } from "@shared/contracts/config";
import { Brain, CaretDown, CaretRight, Check, Eye, ShieldCheck, ShieldWarning, Warning } from "@phosphor-icons/react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import {
	Button,
	cn,
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
	SearchInput,
	Spinner,
	toast,
	Tooltip,
} from "@/ui";
import { focusRing, menuCheckSlot, menuItem, menuItemActive, menuSeparator, rowPicker } from "@/ui/styles";
import { useDisplayedEntries } from "../../chat/branch";
import { composerModel } from "../../collab/lib/modelFallback";
import { getCommand } from "../../registry/commands";
import type { ChatSlotProps } from "../../registry/slots";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { useTsp } from "../../state/tsp/useTsp";
import { semanticThinking } from "./modelTsp";
import { autoAcknowledged, setApprovalMode, useApprovalMode } from "./approval";
import { setThinking, switchModel, thinkingChoices, useChatModels } from "./model";
import { configuredThinking } from "./thinking";
import { containsCurrent, modelRows, modelTree, searchModelTree, type ModelBranch, type ModelNode } from "./modelTree";
import { type StatusLine, THINKING_LEVELS, type ThinkingLevel } from "./screen";
import { useOmpScreen, useSessionView } from "./status";

// ─── Open requests (⌘⇧M and `/switch` → model picker, `/effort` → thinking picker) ───

/**
 * One pending request per picker. The picker that opens for it clears it, so a composer that mounts
 * again later (tab switch, split view) does not open its picker a second time.
 */
interface PickerRequests {
	/** Tab whose composer model picker should open. */
	model: { tabId: string } | null;
	/** Tab whose composer thinking picker should open. */
	thinking: { tabId: string } | null;
	openModel(tabId: string): void;
	openThinking(tabId: string): void;
	/** The request was answered (opened, or dropped for a read-only chat). */
	handled(picker: "model" | "thinking"): void;
}

export const usePickerRequests = create<PickerRequests>()(set => ({
	model: null,
	thinking: null,
	openModel: tabId => set({ model: { tabId } }),
	openThinking: tabId => set({ thinking: { tabId } }),
	handled: picker => set({ [picker]: null }),
}));


// ─── Permission and work modes ─────────────────────────────────────────────


/** Apply a permission mode, asking once before the first switch to Auto (DESIGN §8.4). */
export async function choosePermission(cwd: string, mode: ApprovalMode, current: ApprovalMode | null): Promise<void> {
	if (mode === current) return;
	if (mode === "yolo" && !autoAcknowledged()) {
		useApp.getState().openSheet("session-auto-confirm", { cwd });
		return;
	}
	try {
		await setApprovalMode(cwd, mode);
	} catch (error) {
		toast({ tone: "err", message: error instanceof Error ? error.message : String(error) });
	}
}

/** The work mode omp shows in its status line, most specific first (one at a time, like omp's own UI). */
function activeWorkMode(status: StatusLine | null): string | null {
	if (!status) return null;
	if (status.plan === "on") return "plan";
	if (status.plan === "paused") return "planPaused";
	if (status.goal === "active") return "goal";
	if (status.goal === "paused") return "goalPaused";
	if (status.vibe) return "vibe";
	if (status.loop) return "loop";
	return null;
}

/**
 * The work modes as commands (modes.tsx), with the state omp shows for each. Goal and Repeat open a
 * dialog; the others toggle. The advisor's state is not on omp's status line, so it has none here.
 */
const WORK_MODES: ReadonlyArray<{ id: string; dialog?: boolean; state(status: StatusLine | null): "on" | "paused" | "active" | null }> = [
	{ id: "chat.plan", state: status => (status?.plan === "on" ? "on" : status?.plan === "paused" ? "paused" : null) },
	{ id: "chat.vibe", state: status => (status?.vibe ? "on" : null) },
	{ id: "chat.goal", dialog: true, state: status => (status?.goal === "active" ? "active" : status?.goal === "paused" ? "paused" : null) },
	{ id: "chat.loop", dialog: true, state: status => (status?.loop ? "on" : null) },
	{ id: "chat.advisor", state: () => null },
];

/** The work modes as menu rows, each with the state omp shows for it on the right. */
function WorkModeItems({ session, status }: { session: SessionController; status: StatusLine | null }) {
	const { t } = useTranslation("session");
	return WORK_MODES.map(({ id, dialog, state }) => {
		const command = getCommand(id);
		if (!command) return null;
		const Icon = command.icon;
		const current = state(status);
		return (
			<MenuItem
				key={id}
				title={command.hint ? t(command.hint) : undefined}
				icon={Icon ? <Icon /> : undefined}
				onSelect={() => void command.run({ session, projectPath: session.projectPath })}
			>
				<span className="flex items-center gap-2">
					<span className="min-w-0 flex-1 truncate">
						{t(command.title)}
						{dialog && "…"}
					</span>
					{current && <span className="shrink-0 text-sm font-medium text-accent">{t(`modes.state.${current}`)}</span>}
				</span>
			</MenuItem>
		);
	});
}

export interface PermissionMenuProps {
	projectPath: string;
	disabled?: boolean;
	/** omp's active work mode in words, shown after the level (chats only). */
	workLabel?: string | null;
	/** More menu rows after the levels: a chat's work modes. */
	children?: ReactNode;
}

/**
 * The permission level in words (never icon-only: it says what omp may do on its own). The text wraps inside the
 * button when the row is narrow. Arrows move between rows and Enter applies one, so moving alone never writes the
 * project config (and Auto asks for confirmation first). The level is a project setting, so Home offers it before
 * a chat exists.
 */
export function PermissionMenu({ projectPath, disabled = false, workLabel = null, children }: PermissionMenuProps) {
	const { t } = useTranslation("session");
	const { mode, rawMode, supportedModes, loaded, error } = useApprovalMode(projectPath);
	const [open, setOpen] = useState(false);
	// A chat that turns read-only closes the menu for good rather than reopening it when replies come back.
	if (disabled && open) setOpen(false);
	const Shield = mode === "yolo" || (loaded && mode === null) ? ShieldWarning : ShieldCheck;
	const level = mode ? t(`permission.modes.${mode}.label`) : loaded ? t("permission.unknown") : t("common.loading");
	return (
		<Menu open={open} onOpenChange={setOpen}>
			<Tooltip content={mode ? t(`permission.modes.${mode}.description`) : loaded ? t("permission.unknownHelp", { value: JSON.stringify(rawMode) }) : t("permission.tooltip")}>
				<MenuTrigger asChild disabled={disabled}>
					<button
						type="button"
						aria-label={t("permission.aria", { mode: workLabel ? `${level}, ${workLabel}` : level })}
						data-tour="permission"
						className={cn(rowPicker, "min-h-7 min-w-0 py-1 text-left leading-tight")}
					>
						{loaded ? <Shield className="size-3.5 shrink-0" aria-hidden /> : <Spinner size={12} tone="current" />}
						<span className="min-w-0">
							{loaded && <span>{level}</span>}
							{mode === "yolo" && <span className="text-fg-faint"> · {t("permission.autoNote")}</span>}
							{workLabel && <span className="text-accent"> · {workLabel}</span>}
						</span>
						<CaretDown className="size-3 shrink-0" aria-hidden />
					</button>
				</MenuTrigger>
			</Tooltip>
			<MenuContent side="top" align="start" className="w-80">
				<MenuLabel>{t("permission.title")}</MenuLabel>
				<p className="px-row pb-1 text-sm text-fg-muted">{t("permission.tooltip")}</p>
				<MenuRadioGroup value={mode ?? ""} onValueChange={value => void choosePermission(projectPath, value as ApprovalMode, mode)}>
					{supportedModes.map(option => (
						<MenuRadioItem key={option} value={option} description={t(`permission.modes.${option}.description`)}>
							{t(`permission.modes.${option}.label`)}
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
				<p className="px-row pt-1 text-xs text-fg-faint">{error ?? t("permission.scopeNote")}</p>
				{children}
			</MenuContent>
		</Menu>
	);
}

/** A chat's permission level plus the work mode omp is in; its menu changes both. */
export function PermissionButton({ session }: ChatSlotProps) {
	const { t } = useTranslation("session");
	const { status } = useOmpScreen(session);
	const readOnly = useSessionView(session).readOnly;
	const work = activeWorkMode(status);
	return (
		<PermissionMenu projectPath={session.projectPath} disabled={readOnly} workLabel={work ? t(`modes.active.${work}`) : null}>
			<MenuSeparator />
			<MenuLabel>{t("modes.title")}</MenuLabel>
			<WorkModeItems session={session} status={status} />
		</PermissionMenu>
	);
}

// ─── Model ─────────────────────────────────────────────────────────────────

function formatContext(tokens: number | null): string | null {
	if (!tokens) return null;
	return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}K`;
}

export interface ModelListProps {
	projectPath: string;
	/** The model in use or chosen, checked in the list. */
	current: { provider: string; id: string } | null;
	/** Apply a choice; resolves true once it took effect, so the list closes. */
	onPick(model: ModelInfo): Promise<boolean>;
	onDone(): void;
	/** The chat the list belongs to, for the Model roles and Add provider links; null on Home. */
	session: SessionController | null;
}

/** Searchable provider → model family → version tree shared by chat and Home. */
export function ModelList({ projectPath, current, onPick, onDone, session }: ModelListProps) {
	const { t } = useTranslation("session");
	const { models, error } = useChatModels(projectPath);
	const [query, setQuery] = useState("");
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const [expansion, setExpansion] = useState<Record<string, boolean>>({});
	const [searchExpansion, setSearchExpansion] = useState<Record<string, boolean>>({});
	const [busy, setBusy] = useState<string | null>(null);
	const picking = useRef(false);
	const completion = useRef(onDone);
	completion.current = onDone;
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	const listId = useId();
	const helpId = useId();
	const searchRef = useRef<HTMLInputElement>(null);
	const tree = useMemo(() => modelTree(models ?? []), [models]);
	const filtered = useMemo(() => searchModelTree(tree, query), [tree, query]);
	const searching = query.trim().length > 0;
	const expanded = (node: ModelBranch) => searching
		? searchExpansion[node.key] ?? true
		: expansion[node.key] ?? containsCurrent(node, current);
	const rows = modelRows(filtered, expanded);
	// Identity, rather than a remembered index, prevents query/collapse changes from choosing another leaf.
	const active = rows.find(row => row.node.key === activeKey)
		?? (!searching ? rows.find(row => row.node.kind === "model" && containsCurrent(row.node, current)) : undefined)
		?? rows[0];
	const activeIndex = active ? rows.indexOf(active) : -1;
	const rowId = (key: string) => `${listId}-${encodeURIComponent(key)}`;

	useEffect(() => {
		if (active) document.getElementById(rowId(active.node.key))?.scrollIntoView({ block: "nearest" });
	}, [active?.node.key, listId]);

	const changeQuery = (value: string) => {
		setQuery(value);
		setActiveKey(null);
		setSearchExpansion({});
	};

	const pick = async (model: ModelInfo) => {
		if (picking.current) return;
		if (current && current.provider === model.provider && current.id === model.id) {
			onDone();
			return;
		}
		picking.current = true;
		setBusy(model.selector);
		try {
			if (await onPick(model) && mounted.current) completion.current();
		} catch (error) {
			if (mounted.current) toast({ tone: "err", message: error instanceof Error ? error.message : String(error) });
		} finally {
			picking.current = false;
			if (mounted.current) setBusy(null);
		}
	};

	const setExpanded = (node: ModelBranch, open: boolean) => {
		setActiveKey(node.key);
		const updateExpansion = searching ? setSearchExpansion : setExpansion;
		updateExpansion(previous => ({ ...previous, [node.key]: open }));
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.nativeEvent.isComposing || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const delta = event.key === "ArrowDown" ? 1 : -1;
			setActiveKey(rows[Math.max(0, Math.min(rows.length - 1, activeIndex + delta))]?.node.key ?? null);
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			setActiveKey(rows[event.key === "Home" ? 0 : rows.length - 1]?.node.key ?? null);
		} else if (event.key === "ArrowRight" && active) {
			event.preventDefault();
			if (active.node.kind !== "model") {
				if (expanded(active.node)) setActiveKey(active.node.children[0]?.key ?? active.node.key);
				else setExpanded(active.node, true);
			}
		} else if (event.key === "ArrowLeft" && active) {
			event.preventDefault();
			if (active.node.kind !== "model" && expanded(active.node)) setExpanded(active.node, false);
			else if (active.parent) setActiveKey(active.parent);
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (active?.node.kind === "model") void pick(active.node.model);
			else if (active) setExpanded(active.node, true);
		}
	};

	const renderNode = (node: ModelNode, level: number): ReactNode => {
		const isActive = active?.node.key === node.key;
		const model = node.kind === "model" ? node.model : null;
		const context = model && formatContext(model.contextWindow);
		const capabilities = model ? [
			model.vision && t("model.vision"),
			model.reasoning && t("model.reasoning"),
			context && t("model.contextWindow", { size: context }),
		].filter(Boolean).join(", ") : undefined;
		const open = node.kind !== "model" && expanded(node);
		const row = (
			<div
				data-model-row={node.kind}
				onPointerMove={() => setActiveKey(node.key)}
				onMouseDown={event => event.preventDefault()}
				onClick={() => {
					searchRef.current?.focus();
					setActiveKey(node.key);
					if (node.kind === "model") void pick(node.model);
					else setExpanded(node, !open);
				}}
				className={cn(menuItem, "py-1", isActive && menuItemActive, node.kind === "provider" && "font-semibold")}
			>
				<span aria-hidden className={cn("flex shrink-0", level === 2 ? "w-3" : level === 3 ? "w-6" : "hidden")} />
				<span className={menuCheckSlot}>
					{model ? busy === model.selector ? <Spinner size={12} /> : containsCurrent(node, current) && <Check className="size-4" aria-hidden />
						: open ? <CaretDown className="size-3.5" aria-hidden /> : <CaretRight className="size-3.5" aria-hidden />}
				</span>
				<span className="min-w-0 flex-1 truncate">{node.label}</span>
				{model?.vision && <Eye className="size-3.5 shrink-0 text-fg-faint" aria-label={t("model.vision")} />}
				{model?.reasoning && <Brain className="size-3.5 shrink-0 text-fg-faint" aria-label={t("model.reasoning")} />}
				{context && <span className="shrink-0 font-mono text-xs text-fg-faint">{context}</span>}
			</div>
		);
		return (
			<div
				key={node.key}
				id={rowId(node.key)}
				role="treeitem"
				aria-level={level}
				aria-label={model ? `${model.name}, ${model.selector}, ${model.provider}, ${model.id}` : node.label}
				aria-description={capabilities}
				aria-expanded={node.kind === "model" ? undefined : open}
				aria-selected={model ? containsCurrent(node, current) : undefined}
				aria-disabled={model && busy ? true : undefined}
			>
				{model ? <Tooltip content={<span className="break-all leading-snug">{model.name}<br />{model.selector}<br />{model.id}</span>}>{row}</Tooltip> : row}
				{node.kind !== "model" && open && <div role="group">{node.children.map(child => renderNode(child, level + 1))}</div>}
			</div>
		);
	};

	return (
		<div className="flex min-h-0 max-h-[min(30rem,calc(var(--radix-popover-content-available-height,100dvh)-2*var(--spacing-menu)))] flex-col">
			<SearchInput
				ref={searchRef}
				className="shrink-0"
				autoFocus
				size="sm"
				value={query}
				onValueChange={changeQuery}
				placeholder={t("model.search")}
				onKeyDown={onKeyDown}
				role="combobox"
				aria-label={t("model.search")}
				aria-autocomplete="list"
				aria-haspopup="tree"
				aria-describedby={helpId}
				aria-expanded
				aria-controls={listId}
				aria-activedescendant={active ? rowId(active.node.key) : undefined}
			/>
			<p id={helpId} className="sr-only">{t("model.treeHelp")}</p>
			<div id={listId} role="tree" aria-label={t("model.title")} aria-busy={busy !== null} className="mt-menu min-h-0 max-h-80 overflow-y-auto">
				{models === null && !error && (
					<div className="flex items-center gap-2 px-row py-3 text-sm text-fg-muted">
						<Spinner size={12} /> {t("model.loading")}
					</div>
				)}
				{error && <p className="px-row py-3 text-sm text-err">{error}</p>}
				{models !== null && filtered.length === 0 && (
					<p className="px-row py-3 text-sm text-fg-muted">{t(models.length === 0 ? "model.noModels" : "model.empty")}</p>
				)}
				{filtered.map(node => renderNode(node, 1))}
			</div>
			<div role="separator" className={menuSeparator} />
			<div className="flex shrink-0 flex-wrap justify-end gap-x-2 gap-y-1 px-row">
				<p className="w-full text-xs text-fg-faint">{t("model.scopeNote")}</p>
				{getCommand("manage.roles") && (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							onDone();
							void getCommand("manage.roles")?.run({ session, projectPath });
						}}
					>
						{t("model.roles")}
					</Button>
				)}
				{getCommand("manage.providers") && (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							onDone();
							void getCommand("manage.providers")?.run({ session, projectPath });
						}}
					>
						{t("model.addProvider")}
					</Button>
				)}
			</div>
		</div>
	);
}

export function ModelButton({ session }: ChatSlotProps) {
	const { t } = useTranslation("session");
	const view = useSessionView(session);
	const entries = useDisplayedEntries(view);
	const live = view.guest?.state?.model;
	const stream = view.guest?.stream ?? null;
	const { model, selectedModel, fallback } = useMemo(() => composerModel(entries, live, stream), [entries, live, stream]);
	const [open, setOpen] = useState(false);
	if (view.readOnly && open) setOpen(false);
	const request = usePickerRequests(state => state.model);
	useEffect(() => {
		if (request?.tabId !== session.tabId) return;
		usePickerRequests.getState().handled("model");
		// A read-only chat can't switch models; the request is dropped, not replayed once replies are back on.
		if (!session.getSnapshot().readOnly) setOpen(true);
	}, [request, session]);
	// Saved chats record only omp's provider/id selector; the catalog supplies the name live chats show.
	const { models } = useChatModels(session.projectPath);
	const catalogName = model ? models?.find(entry => entry.provider === model.provider && entry.id === model.id)?.name : undefined;
	const name = catalogName ?? model?.name ?? t("model.none");
	const label = fallback
		? t(fallback.source === "provider" ? "model.providerFallbackAria" : fallback.from ? "model.fallbackAria" : "model.fallbackUnknownAria", { name, from: fallback.from })
		: t("model.aria", { name });
	return (
		<Popover open={open} onOpenChange={setOpen}>
			{/* The name truncates at the button's max width, so the tooltip carries it in full. */}
			<Tooltip content={label} shortcut="⌘⇧M">
				<PopoverTrigger asChild disabled={view.readOnly}>
					<button
						type="button"
						aria-label={label}
						className={cn(rowPicker, "h-7 min-w-0 max-w-[min(16rem,100%)] shrink-0", fallback && "text-warn")}
					>
						{fallback && <Warning weight="fill" className="size-3.5 shrink-0" aria-hidden />}
						<span className="truncate">{name}</span>
						{fallback && <span className="shrink-0 text-xs">{t("model.fallback")}</span>}
						<CaretDown className="size-3 shrink-0" aria-hidden />
					</button>
				</PopoverTrigger>
			</Tooltip>
			<PopoverContent side="top" align="end" width={340} sideOffset={6} className="p-menu">
				<ModelList
					projectPath={session.projectPath}
					current={selectedModel}
					session={session}
					onDone={() => setOpen(false)}
					onPick={async picked => {
						const ok = await switchModel(session, picked);
						if (ok) toast({ tone: "ok", message: t("model.switched", { name: picked.name }) });
						return ok;
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

// ─── Thinking ──────────────────────────────────────────────────────────────

/** Configured thinking level: Auto stays Auto (see `configuredThinking`), else the painted or effective level. */
export function useThinking(session: SessionController): ThinkingLevel | null {
	const status = useOmpScreen(session).status;
	const view = useSessionView(session);
	const tsp = useTsp(view.host?.transport === "tsp" ? view.host.hostId : null).snapshot;
	const entries = useDisplayedEntries(view);
	const configured = configuredThinking(view.guest?.thinkingSelector, entries, status?.thinking ?? null);
	const effective = view.guest?.state?.thinkingLevel;
	if (view.host?.transport === "tsp") return semanticThinking(tsp, view.guest?.thinkingSelector, entries) ?? configured ?? THINKING_LEVELS.find(level => level === effective) ?? null;
	return configured ?? THINKING_LEVELS.find(level => level === effective) ?? null;
}

function useCurrentModelInfo(session: SessionController): ModelInfo | undefined {
	const { models } = useChatModels(session.projectPath);
	const model = useSessionView(session).guest?.state?.model;
	return models?.find(entry => entry.provider === model?.provider && entry.id === model?.id);
}

export function ThinkingButton({ session }: ChatSlotProps) {
	const { t } = useTranslation("session");
	const level = useThinking(session);
	const info = useCurrentModelInfo(session);
	const choices = thinkingChoices(info);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState<ThinkingLevel | null>(null);
	const readOnly = useSessionView(session).readOnly;
	if (readOnly && open) setOpen(false);
	const unsupported = info !== undefined && choices.length === 0;
	const disabled = readOnly || unsupported;
	const request = usePickerRequests(state => state.thinking);
	const unsupportedNow = useRef(unsupported);
	unsupportedNow.current = unsupported;
	useEffect(() => {
		if (request?.tabId !== session.tabId) return;
		usePickerRequests.getState().handled("thinking");
		// Like the model picker, a request for a read-only chat is dropped.
		if (session.getSnapshot().readOnly) return;
		if (unsupportedNow.current) toast({ message: t("thinking.unsupported") });
		else setOpen(true);
	}, [request, session, t]);
	const pick = async (target: ThinkingLevel) => {
		if (busy) return;
		if (target === level) {
			setOpen(false);
			return;
		}
		setBusy(target);
		const ok = await setThinking(session, target, choices);
		setBusy(null);
		if (ok) setOpen(false);
	};
	const label = t("thinking.aria", { level: level ? t(`thinking.levels.${level}.label`) : t("common.unknown") });
	return (
		<Menu open={open} onOpenChange={setOpen}>
			<Tooltip content={unsupported ? t("thinking.unsupported") : label} shortcut="⇧⇥">
				<MenuTrigger asChild disabled={disabled}>
					<button type="button" aria-label={label} aria-busy={busy !== null} className={cn(rowPicker, "h-7 shrink-0")}>
						{busy ? <Spinner size={12} tone="current" /> : <Brain className="size-3.5 shrink-0" aria-hidden />}
						<span>{level ? t(`thinking.levels.${level}.label`) : t("thinking.title")}</span>
						<CaretDown className="size-3 shrink-0" aria-hidden />
					</button>
				</MenuTrigger>
			</Tooltip>
			{/* The menu stays open until omp confirms the level, so a refused switch is not mistaken for a done one. */}
			<MenuContent side="top" align="end" className="w-72">
				<MenuLabel>{t("thinking.title")}</MenuLabel>
				<MenuRadioGroup value={level ?? ""}>
					{(choices.length > 0 ? choices : level ? [level] : []).map(choice => (
						<MenuRadioItem
							key={choice}
							value={choice}
							disabled={busy !== null && busy !== choice}
							description={t(`thinking.levels.${choice}.description`)}
							onSelect={event => {
								event.preventDefault();
								void pick(choice);
							}}
						>
							{t(`thinking.levels.${choice}.label`)}
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
			</MenuContent>
		</Menu>
	);
}
