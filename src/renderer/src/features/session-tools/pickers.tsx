/**
 * Composer bottom-row pickers (permission button, model, thinking) and the session-header model + mode
 * chips (DESIGN §3.4, §3.6). Each change goes through omp and is confirmed from omp's own state. The
 * composer pickers compact with the card's row steps (`group-data-*` variants on `group/composer`).
 */
import type { ApprovalMode, ModelInfo } from "@shared/contracts/config";
import { Brain, CaretDown, Check, Cpu, Eye, ShieldCheck, ShieldWarning } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import {
	Button,
	cn,
	Menu,
	MenuCheckboxItem,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuSub,
	MenuTrigger,
	Popover,
	PopoverContent,
	PopoverTrigger,
	SearchInput,
	Spinner,
	spring,
	toast,
	Tooltip,
} from "@/ui";
import { focusRing, focusRingInset, menuLabel } from "@/ui/styles";
import { getCommand } from "../../registry/commands";
import type { ChatSlotProps } from "../../registry/slots";
import { useApp } from "../../state/app";
import type { SessionController } from "../../state/session";
import { autoAcknowledged, setApprovalMode, useApprovalMode } from "./approval";
import { setThinking, switchModel, thinkingChoices, useChatModels } from "./model";
import { THINKING_LEVELS, type ThinkingLevel } from "./screen";
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

/**
 * Selected-row fill that slides to the new row when the selection moves. `layoutId` must be unique per
 * list instance (derive it from `useId()`); the row needs `relative isolate`.
 */
function SelectionFill({ layoutId, className }: { layoutId: string; className?: string }) {
	return <motion.span aria-hidden layoutId={layoutId} transition={spring.snappy} className={cn("absolute inset-0 -z-10 bg-selected", className)} />;
}

// ─── Permission ────────────────────────────────────────────────────────────

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

function PermissionOptions({ cwd, mode, onPicked }: { cwd: string; mode: ApprovalMode | null; onPicked(): void }) {
	const { t } = useTranslation("session");
	const fillId = `${useId()}-permission`;
	return (
		<div role="radiogroup" aria-label={t("permission.title")} className="flex flex-col gap-0.5">
			{APPROVAL_MODES.map(option => (
				<button
					key={option}
					type="button"
					role="radio"
					aria-checked={mode === option}
					onClick={() => {
						onPicked();
						void choosePermission(cwd, option, mode);
					}}
					className={cn(
						"relative isolate flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-(--dur-fast) hover:bg-hover",
						focusRingInset,
					)}
				>
					{mode === option && <SelectionFill layoutId={fillId} className="rounded-md" />}
					<span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center text-accent">
						{mode === option && <Check className="size-4" aria-hidden />}
					</span>
					<span className="min-w-0 flex-1">
						<span className="block text-md font-medium text-fg">{t(`permission.modes.${option}.label`)}</span>
						<span className="block text-sm text-fg-muted">{t(`permission.modes.${option}.description`)}</span>
					</span>
				</button>
			))}
		</div>
	);
}

/** Ghost 28px control shared by the composer's labelled pickers. */
const rowPicker = cn(
	"inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-fg-muted",
	"transition-colors duration-(--dur-fast) enabled:hover:bg-hover enabled:hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg",
	"disabled:cursor-not-allowed disabled:opacity-45",
	focusRing,
);

export function PermissionPill({ session }: ChatSlotProps) {
	const { t } = useTranslation("session");
	const { mode, error } = useApprovalMode(session.projectPath);
	const [open, setOpen] = useState(false);
	const Shield = mode === "yolo" ? ShieldWarning : ShieldCheck;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip content={mode ? t(`permission.modes.${mode}.description`) : t("permission.tooltip")}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={t("permission.aria", { mode: mode ? t(`permission.modes.${mode}.label`) : t("common.loading") })}
						className={cn(rowPicker, "shrink-0 group-data-fold-tools/composer:hidden")}
					>
						{mode ? <Shield className="size-3.5 shrink-0" aria-hidden /> : <Spinner size={12} tone="current" />}
						{mode && <span>{t(`permission.modes.${mode}.label`)}</span>}
						{mode === "yolo" && <span className="text-fg-faint group-data-compact-pill/composer:hidden">· {t("permission.autoNote")}</span>}
						<CaretDown className="size-3 shrink-0" aria-hidden />
					</button>
				</PopoverTrigger>
			</Tooltip>
			<PopoverContent side="top" align="start" width={320} className="p-2">
				<p className={menuLabel}>{t("permission.title")}</p>
				<p className="px-2 pb-2 text-sm text-fg-muted">{t("permission.tooltip")}</p>
				<PermissionOptions cwd={session.projectPath} mode={mode} onPicked={() => setOpen(false)} />
				<p className="mt-2 border-t border-border px-2 pt-2 text-xs text-fg-faint">{error ?? t("permission.scopeNote")}</p>
			</PopoverContent>
		</Popover>
	);
}

/** The permission levels as a submenu of the composer's ＋ menu, for a card too narrow for the button. */
export function PermissionSubmenu({ session }: ChatSlotProps) {
	const { t } = useTranslation("session");
	const { mode } = useApprovalMode(session.projectPath);
	return (
		<MenuSub label={t("permission.title")} icon={mode === "yolo" ? <ShieldWarning /> : <ShieldCheck />}>
			<MenuRadioGroup
				value={mode ?? ""}
				onValueChange={value => {
					const next = APPROVAL_MODES.find(option => option === value);
					if (next) void choosePermission(session.projectPath, next, mode);
				}}
			>
				{APPROVAL_MODES.map(option => (
					<MenuRadioItem key={option} value={option}>
						{t(`permission.modes.${option}.label`)}
					</MenuRadioItem>
				))}
			</MenuRadioGroup>
		</MenuSub>
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
		const ok = await switchModel(session, model.selector);
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
				className="relative isolate flex h-9 cursor-default select-none items-center gap-2 rounded-sm px-2 text-md"
			>
				{index === active && <SelectionFill layoutId={`${listId}-active`} className="rounded-sm" />}
				<span className="inline-flex size-4 shrink-0 items-center justify-center text-accent">
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
			{/* layoutScroll keeps the sliding highlight aligned while the list scrolls. */}
			<motion.div layoutScroll ref={listRef} id={listId} role="listbox" aria-label={t("model.title")} className="mt-2 max-h-80 overflow-y-auto">
				{models === null && !error && (
					<div className="flex items-center gap-2 px-2 py-3 text-sm text-fg-muted">
						<Spinner size={12} /> {t("model.loading")}
					</div>
				)}
				{error && <p className="px-2 py-3 text-sm text-err">{error}</p>}
				{models !== null && filtered.length === 0 && (
					<p className="px-2 py-3 text-sm text-fg-muted">{t(models.length === 0 ? "model.noModels" : "model.empty")}</p>
				)}
				{rows}
			</motion.div>
			<div className="mt-2 flex items-center gap-2 border-t border-border px-2 pt-2">
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
	const model = useSessionView(session).guest?.state?.model;
	const [open, setOpen] = useState(false);
	const request = usePickerRequests(state => state.model);
	useEffect(() => {
		if (request?.tabId === session.tabId) setOpen(true);
	}, [request, session.tabId]);
	const name = model?.name ?? t("model.none");
	return (
		<Popover open={open} onOpenChange={setOpen}>
			{/* The composer row may truncate the name or show only the icon, so the tooltip carries the name in full. */}
			<Tooltip content={t("model.aria", { name })} shortcut="⌘⇧M">
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={t("model.aria", { name })}
						className={cn(
							rowPicker,
							"min-w-7 max-w-44 group-data-compact-model/composer:w-7 group-data-compact-model/composer:justify-center group-data-compact-model/composer:px-0",
							// Folded into the ＋ menu: a zero-width, invisible anchor so the picker still opens at the row's end.
							"group-data-fold-model/composer:invisible group-data-fold-model/composer:-ml-0.5 group-data-fold-model/composer:max-w-0 group-data-fold-model/composer:min-w-0 group-data-fold-model/composer:overflow-hidden",
						)}
					>
						<Cpu className="hidden size-4 shrink-0 group-data-compact-model/composer:block" aria-hidden />
						<span data-row-label className="truncate group-data-compact-model/composer:hidden">
							{name}
						</span>
						<CaretDown className="size-3 shrink-0 group-data-compact-model/composer:hidden" aria-hidden />
					</button>
				</PopoverTrigger>
			</Tooltip>
			<PopoverContent side="top" align="end" width={340} className="p-2">
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
	const thinkingFill = `${useId()}-thinking`;
	const disabled = info !== undefined && choices.length === 0;
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
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip content={disabled ? t("thinking.unsupported") : label} shortcut="⇧⇥">
				<PopoverTrigger asChild disabled={disabled}>
					<button
						type="button"
						aria-label={label}
						className={cn(
							rowPicker,
							"shrink-0 group-data-compact-thinking/composer:w-7 group-data-compact-thinking/composer:justify-center group-data-compact-thinking/composer:px-0 group-data-fold-thinking/composer:hidden",
						)}
					>
						<Brain className="size-3.5 shrink-0 group-data-compact-thinking/composer:size-4" aria-hidden />
						<span className="group-data-compact-thinking/composer:hidden">{level ? t(`thinking.levels.${level}.label`) : t("thinking.title")}</span>
						<CaretDown className="size-3 shrink-0 group-data-compact-thinking/composer:hidden" aria-hidden />
					</button>
				</PopoverTrigger>
			</Tooltip>
			<PopoverContent side="top" align="end" width={280} className="p-1">
				<p className={menuLabel}>{t("thinking.title")}</p>
				<div role="radiogroup" aria-label={t("thinking.title")} className="flex flex-col">
					{(choices.length > 0 ? choices : level ? [level] : []).map(choice => (
						<button
							key={choice}
							type="button"
							role="radio"
							aria-checked={choice === level}
							onClick={() => void pick(choice)}
							className={cn(
								"relative isolate flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-hover",
								focusRingInset,
							)}
						>
							{choice === level && <SelectionFill layoutId={thinkingFill} className="rounded-sm" />}
							<span className="inline-flex size-4 shrink-0 items-center justify-center text-accent">
								{busy === choice ? <Spinner size={12} /> : choice === level && <Check className="size-4" aria-hidden />}
							</span>
							<span className="min-w-0 flex-1">
								<span className="block text-md text-fg">{t(`thinking.levels.${choice}.label`)}</span>
								<span className="block text-xs text-fg-muted">{t(`thinking.levels.${choice}.description`)}</span>
							</span>
						</button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}

/** The thinking levels as a submenu of the composer's ＋ menu, for a row too narrow for the button. */
export function ThinkingSubmenu({ session }: ChatSlotProps) {
	const { t } = useTranslation("session");
	const level = useThinking(session);
	const info = useCurrentModelInfo(session);
	const choices = thinkingChoices(info);
	const options = choices.length > 0 ? choices : level ? [level] : [];
	return (
		<MenuSub label={t("thinking.title")} icon={<Brain />} disabled={info !== undefined && choices.length === 0}>
			<MenuRadioGroup
				value={level ?? ""}
				onValueChange={value => {
					const target = options.find(option => option === value);
					if (!target || target === level) return;
					void setThinking(session, target, choices).then(ok => {
						if (!ok) toast({ tone: "warn", message: t("thinking.failed") });
					});
				}}
			>
				{options.map(choice => (
					<MenuRadioItem key={choice} value={choice}>
						{t(`thinking.levels.${choice}.label`)}
					</MenuRadioItem>
				))}
			</MenuRadioGroup>
		</MenuSub>
	);
}

// ─── Header chips ──────────────────────────────────────────────────────────

const chipButton = cn(
	"inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-semibold",
	"transition-[filter,background-color,color] duration-(--dur-fast) hover:brightness-95 data-[state=open]:brightness-95",
	focusRing,
);

function ModelChip({ session }: { session: SessionController }) {
	const { t } = useTranslation("session");
	const model = useSessionView(session).guest?.state?.model;
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip content={t("model.tooltip")} shortcut="⌘⇧M">
				<PopoverTrigger asChild>
					<button type="button" aria-label={t("model.aria", { name: model?.name ?? t("model.none") })} className={cn(chipButton, "max-w-48 bg-hover text-fg")}>
						<span className="truncate">{model?.name ?? t("model.none")}</span>
						<CaretDown className="size-3 shrink-0" aria-hidden />
					</button>
				</PopoverTrigger>
			</Tooltip>
			<PopoverContent side="bottom" align="start" width={340} className="p-2">
				<ModelList session={session} onDone={() => setOpen(false)} />
			</PopoverContent>
		</Popover>
	);
}

function runCommandById(id: string, session: SessionController): void {
	void getCommand(id)?.run({ session, projectPath: session.projectPath });
}

function ModeChip({ session }: { session: SessionController }) {
	const { t } = useTranslation("session");
	const { status } = useOmpScreen(session);
	const { mode } = useApprovalMode(session.projectPath);
	const special =
		status?.plan === "on"
			? t("modes.chip.plan")
			: status?.plan === "paused"
				? t("modes.chip.planPaused")
				: status?.goal === "active"
					? t("modes.chip.goal")
					: status?.goal === "paused"
						? t("modes.chip.goalPaused")
						: status?.vibe
							? t("modes.chip.vibe")
							: status?.loop
								? t("modes.chip.loop")
								: null;
	const label = special ?? (mode ? t(`permission.modes.${mode}.label`) : null);
	if (!label) return null;
	return (
		<Menu>
			<Tooltip content={t("modes.chip.tooltip")}>
				<MenuTrigger asChild>
					<button type="button" aria-label={t("modes.chip.aria", { mode: label })} className={cn(chipButton, special ? "bg-accent-muted text-accent" : "bg-hover text-fg-muted")}>
						{label}
						<CaretDown className="size-3" aria-hidden />
					</button>
				</MenuTrigger>
			</Tooltip>
			<MenuContent className="w-64">
				<MenuLabel>{t("permission.title")}</MenuLabel>
				<MenuRadioGroup
					value={mode ?? ""}
					onValueChange={value => {
						const next = APPROVAL_MODES.find(option => option === value);
						if (next) void choosePermission(session.projectPath, next, mode);
					}}
				>
					{APPROVAL_MODES.map(option => (
						<MenuRadioItem key={option} value={option}>
							{t(`permission.modes.${option}.label`)}
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
				<MenuSeparator />
				<MenuLabel>{t("modes.chip.ways")}</MenuLabel>
				<MenuCheckboxItem checked={status?.plan === "on"} onSelect={() => runCommandById("chat.plan", session)}>
					{t("commands.plan.title")}
				</MenuCheckboxItem>
				<MenuCheckboxItem checked={status?.vibe ?? false} onSelect={() => runCommandById("chat.vibe", session)}>
					{t("commands.vibe.title")}
				</MenuCheckboxItem>
				<MenuItem onSelect={() => runCommandById("chat.goal", session)}>{t("commands.goal.title")}…</MenuItem>
				<MenuItem onSelect={() => runCommandById("chat.loop", session)}>{t("commands.loop.title")}…</MenuItem>
				<MenuItem onSelect={() => runCommandById("chat.advisor", session)}>{t("commands.advisor.title")}</MenuItem>
			</MenuContent>
		</Menu>
	);
}

export function HeaderChips({ session }: ChatSlotProps) {
	const view = useSessionView(session);
	if (!view.guest) return null;
	return (
		<div className="flex items-center gap-1.5">
			<ModelChip session={session} />
			<ModeChip session={session} />
		</div>
	);
}
