/**
 * Pickers in the quiet row under the composer card (DESIGN §3.6): the permission button with its work
 * modes, the model button and the thinking button. Each change goes through omp and is confirmed from
 * omp's own state. All of them keep their words; the row wraps when the column is narrow, the model name
 * truncates at the button's max width, and the permission text wraps inside its button.
 */
import type { ApprovalMode, ModelInfo } from "@shared/contracts/config";
import { Brain, CaretDown, Check, Eye, ShieldCheck, ShieldWarning } from "@phosphor-icons/react";
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
import { focusRing, menuCheckSlot, menuItem, menuItemActive, menuLabel, menuSeparator } from "@/ui/styles";
import { getCommand } from "../../registry/commands";
import type { ChatSlotProps } from "../../registry/slots";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { autoAcknowledged, setApprovalMode, useApprovalMode } from "./approval";
import { setThinking, switchModel, thinkingChoices, useChatModels } from "./model";
import { type StatusLine, THINKING_LEVELS, type ThinkingLevel } from "./screen";
import { useOmpScreen, useSessionView } from "./status";

// ─── Open requests (menu accelerator ⌘⇧M → model picker) ───────────────────

interface PickerRequests {
	/** Tab whose composer model picker should open, bumped per request. */
	model: { tabId: string; seq: number } | null;
	openModel(tabId: string): void;
}

export const usePickerRequests = create<PickerRequests>()(set => ({
	model: null,
	openModel: tabId => set(state => ({ model: { tabId, seq: (state.model?.seq ?? 0) + 1 } })),
}));

/** Ghost 28px-high control shared by the composer's labelled pickers (each adds its own height rule). */
const rowPicker = cn(
	"inline-flex items-center gap-1.5 rounded-md px-2 text-sm font-medium text-fg-muted",
	"transition-colors duration-(--dur-fast) enabled:hover:bg-hover enabled:hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg",
	"disabled:cursor-not-allowed disabled:opacity-45",
	focusRing,
);

// ─── Permission and work modes ─────────────────────────────────────────────

const APPROVAL_MODES: readonly ApprovalMode[] = ["always-ask", "write", "yolo"];

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

/**
 * The permission level in words (never icon-only: it says what omp may do on its own), plus the work mode
 * omp is in. The text wraps inside the button when the composer row is narrow. Its menu changes both:
 * arrows move between rows and Enter applies one, so moving alone never writes the project config (and
 * Auto asks for confirmation first).
 */
export function PermissionButton({ session }: ChatSlotProps) {
	const { t } = useTranslation("session");
	const { mode, error } = useApprovalMode(session.projectPath);
	const { status } = useOmpScreen(session);
	const readOnly = useSessionView(session).readOnly;
	const [open, setOpen] = useState(false);
	// A chat that turns read-only closes the menu for good rather than reopening it when replies come back.
	if (readOnly && open) setOpen(false);
	const Shield = mode === "yolo" ? ShieldWarning : ShieldCheck;
	const level = mode ? t(`permission.modes.${mode}.label`) : t("common.loading");
	const work = activeWorkMode(status);
	const workLabel = work ? t(`modes.active.${work}`) : null;
	return (
		<Menu open={open} onOpenChange={setOpen}>
			<Tooltip content={mode ? t(`permission.modes.${mode}.description`) : t("permission.tooltip")}>
				<MenuTrigger asChild disabled={readOnly}>
					<button
						type="button"
						aria-label={t("permission.aria", { mode: workLabel ? `${level}, ${workLabel}` : level })}
						data-tour="permission"
						className={cn(rowPicker, "min-h-7 min-w-0 py-1 text-left leading-tight")}
					>
						{mode ? <Shield className="size-3.5 shrink-0" aria-hidden /> : <Spinner size={12} tone="current" />}
						<span className="min-w-0">
							{mode && <span>{level}</span>}
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
				<MenuRadioGroup
					value={mode ?? ""}
					onValueChange={value => void choosePermission(session.projectPath, value as ApprovalMode, mode)}
				>
					{APPROVAL_MODES.map(option => (
						<MenuRadioItem key={option} value={option} description={t(`permission.modes.${option}.description`)}>
							{t(`permission.modes.${option}.label`)}
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
				<p className="px-row pt-1 text-xs text-fg-faint">{error ?? t("permission.scopeNote")}</p>
				<MenuSeparator />
				<MenuLabel>{t("modes.title")}</MenuLabel>
				<WorkModeItems session={session} status={status} />
			</MenuContent>
		</Menu>
	);
}

// ─── Model ─────────────────────────────────────────────────────────────────

function formatContext(tokens: number | null): string | null {
	if (!tokens) return null;
	return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}K`;
}

function ModelList({ session, onDone }: { session: SessionController; onDone(): void }) {
	const { t } = useTranslation("session");
	const { models, error } = useChatModels(session.projectPath);
	const current = useSessionView(session).guest?.state?.model;
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [busy, setBusy] = useState<string | null>(null);
	const listId = useId();
	const listRef = useRef<HTMLDivElement>(null);

	const filtered = useMemo(() => {
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		return (models ?? [])
			.filter(model => {
				const haystack = `${model.name} ${model.id} ${model.provider}`.toLowerCase();
				return tokens.every(token => haystack.includes(token));
			})
			.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
	}, [models, query]);

	useEffect(() => {
		setActive(0);
	}, [query]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const pick = async (model: ModelInfo) => {
		if (busy) return;
		if (current && current.provider === model.provider && current.id === model.id) {
			onDone();
			return;
		}
		setBusy(model.selector);
		const ok = await switchModel(session, model);
		setBusy(null);
		if (ok) {
			toast({ tone: "ok", message: t("model.switched", { name: model.name }) });
			onDone();
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const delta = event.key === "ArrowDown" ? 1 : -1;
			setActive(index => Math.max(0, Math.min(filtered.length - 1, index + delta)));
		} else if (event.key === "Enter") {
			event.preventDefault();
			const model = filtered[active];
			if (model) void pick(model);
		}
	};

	const rows: ReactNode[] = [];
	let provider: string | null = null;
	filtered.forEach((model, index) => {
		if (model.provider !== provider) {
			provider = model.provider;
			rows.push(
				<div key={`p:${provider}`} role="presentation" className={menuLabel}>
					{provider}
				</div>,
			);
		}
		const selected = current?.provider === model.provider && current.id === model.id;
		const context = formatContext(model.contextWindow);
		rows.push(
			<div
				key={model.selector}
				id={`${listId}-${index}`}
				role="option"
				aria-selected={index === active}
				data-index={index}
				onPointerMove={() => setActive(index)}
				onClick={() => void pick(model)}
				className={cn(menuItem, index === active && menuItemActive)}
			>
				<span className={menuCheckSlot}>
					{busy === model.selector ? <Spinner size={12} /> : selected && <Check className="size-4" aria-hidden />}
				</span>
				<span className="min-w-0 flex-1 truncate">{model.name}</span>
				{model.vision && <Eye className="size-3.5 shrink-0 text-fg-faint" aria-label={t("model.vision")} />}
				{model.reasoning && <Brain className="size-3.5 shrink-0 text-fg-faint" aria-label={t("model.reasoning")} />}
				{context && <span className="shrink-0 font-mono text-xs text-fg-faint">{context}</span>}
			</div>,
		);
	});

	return (
		<div className="flex flex-col">
			<SearchInput
				autoFocus
				size="sm"
				value={query}
				onValueChange={setQuery}
				placeholder={t("model.search")}
				onKeyDown={onKeyDown}
				role="combobox"
				aria-expanded
				aria-controls={listId}
				aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
			/>
			<div ref={listRef} id={listId} role="listbox" aria-label={t("model.title")} className="mt-menu max-h-80 overflow-y-auto">
				{models === null && !error && (
					<div className="flex items-center gap-2 px-row py-3 text-sm text-fg-muted">
						<Spinner size={12} /> {t("model.loading")}
					</div>
				)}
				{error && <p className="px-row py-3 text-sm text-err">{error}</p>}
				{models !== null && filtered.length === 0 && (
					<p className="px-row py-3 text-sm text-fg-muted">{t(models.length === 0 ? "model.noModels" : "model.empty")}</p>
				)}
				{rows}
			</div>
			<div role="separator" className={menuSeparator} />
			<div className="flex items-center gap-2 pl-row">
				<p className="min-w-0 flex-1 text-xs text-fg-faint">{t("model.scopeNote")}</p>
				{getCommand("manage.roles") && (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							onDone();
							void getCommand("manage.roles")?.run({ session, projectPath: session.projectPath });
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
							void getCommand("manage.providers")?.run({ session, projectPath: session.projectPath });
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
	const model = view.guest?.state?.model;
	const [open, setOpen] = useState(false);
	if (view.readOnly && open) setOpen(false);
	const request = usePickerRequests(state => state.model);
	useEffect(() => {
		// A read-only chat can't switch models; the request is dropped, not replayed once replies are back on.
		if (request?.tabId === session.tabId && !session.getSnapshot().readOnly) setOpen(true);
	}, [request, session]);
	const name = model?.name ?? t("model.none");
	return (
		<Popover open={open} onOpenChange={setOpen}>
			{/* The name truncates at the button's max width, so the tooltip carries it in full. */}
			<Tooltip content={t("model.aria", { name })} shortcut="⌘⇧M">
				<PopoverTrigger asChild disabled={view.readOnly}>
					<button
						type="button"
						aria-label={t("model.aria", { name })}
						className={cn(rowPicker, "h-7 min-w-0 max-w-44 shrink-0")}
					>
						<span className="truncate">{name}</span>
						<CaretDown className="size-3 shrink-0" aria-hidden />
					</button>
				</PopoverTrigger>
			</Tooltip>
			<PopoverContent side="top" align="end" width={340} sideOffset={6} className="p-menu">
				<ModelList session={session} onDone={() => setOpen(false)} />
			</PopoverContent>
		</Popover>
	);
}

// ─── Thinking ──────────────────────────────────────────────────────────────

/** Configured thinking level: omp's status line (keeps `auto`), else the effective level omp reports. */
function useThinking(session: SessionController): ThinkingLevel | null {
	const status = useOmpScreen(session).status;
	const effective = useSessionView(session).guest?.state?.thinkingLevel;
	if (status?.thinking) return status.thinking;
	return THINKING_LEVELS.find(level => level === effective) ?? null;
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
		else toast({ tone: "warn", message: t("thinking.failed") });
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
