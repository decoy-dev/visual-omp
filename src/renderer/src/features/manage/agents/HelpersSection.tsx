/**
 * Settings → Helpers (DESIGN §4.14): omp's task agents, built-in and custom, with on/off switches,
 * model overrides and an editor. Running helper work shows in the chat, not here.
 */
import type { AgentEntry, AgentFileError, AgentScope, AgentWritableScope } from "@shared/contracts/agents";
import { ArrowsClockwise, ChatText, Copy, DotsThree, PencilSimple, Play, Plus, Trash, Warning, Wrench } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type Ref, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useComposerDrafts } from "@/chat/composer/drafts";
import type { SettingsSectionProps } from "@/registry/slots";
import { controllerFor, useApp } from "@/state/app";
import {
	Button,
	Chip,
	cn,
	Dialog,
	DialogContent,
	EmptyState,
	IconButton,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	PageHeader,
	SearchInput,
	Segmented,
	Skeleton,
	Switch,
	toast,
} from "@/ui";
import { listRowMotion } from "../listMotion";
import { ipcErrorMessage, useResource } from "../shared";
import { AgentEditor, type EditorTarget } from "./AgentEditor";
import { copyName, createWithAiPrompt, duplicateAgentDraft } from "./agentsModel";
import { CreateWithAiDialog } from "./CreateWithAiDialog";

export type HelpersFilter = "all" | AgentScope;

/** Deep-link props (`openSettings("helpers", { sectionProps })`). */
export interface HelpersSectionProps {
	/** Filter to show first: `project` for this project's helpers, `user` for all-projects helpers. */
	filter?: HelpersFilter;
}

export function HelpersSection({ projectPath: cwd, props }: SettingsSectionProps) {
	const { t } = useTranslation("manage");
	const list = useResource(() => window.vomp.invoke("agents:list", cwd, false), [cwd]);
	const models = useResource(() => window.vomp.invoke("config:models", cwd ?? undefined), [cwd]);
	// Each deep link remounts the section (SettingsPage), so the linked filter applies once here.
	const [filter, setFilter] = useState<HelpersFilter>((props as HelpersSectionProps | undefined)?.filter ?? "all");
	const [query, setQuery] = useState("");
	const [editor, setEditor] = useState<EditorTarget | null>(null);
	const [aiOpen, setAiOpen] = useState(false);
	const [deleting, setDeleting] = useState<AgentEntry | null>(null);
	const [reloading, setReloading] = useState(false);
	const { reload } = list;

	// App writes announce themselves; files written by omp in a chat show up when the window regains focus.
	useEffect(() => {
		const off = window.vomp.on("agents:changed", event => {
			if (event.cwd === null || event.cwd === cwd) void reload();
		});
		const onFocus = () => void reload();
		window.addEventListener("focus", onFocus);
		return () => {
			off();
			window.removeEventListener("focus", onFocus);
		};
	}, [cwd, reload]);

	const snapshot = list.data;
	const projectAvailable = Boolean(cwd && (snapshot?.dirs.project ?? snapshot?.dirs.projectDefault));
	const takenNames = useMemo(() => new Set(snapshot?.agents.map(agent => agent.name) ?? []), [snapshot]);
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const visible = (snapshot?.agents ?? []).filter(
		agent =>
			agent.active &&
			(filter === "all" || agent.scope === filter) &&
			words.every(word => `${agent.name} ${agent.description}`.toLowerCase().includes(word)),
	);
	const errors = (snapshot?.errors ?? []).filter(error => filter === "all" || error.scope === filter);

	/** Opens a new chat in this project; the chat replaces Settings. */
	const startChat = async (build: (tabId: string) => void | Promise<void>) => {
		if (!cwd) {
			toast({ tone: "warn", message: t("agents.needsProject") });
			return false;
		}
		const tabId = await useApp.getState().newChat(cwd);
		if (!tabId) return false;
		void build(tabId);
		return true;
	};
	const runNow = (name: string) => void startChat(tabId => useComposerDrafts.getState().insert(tabId, `Use the ${name} agent to `));

	const guard = async (run: () => Promise<unknown>) => {
		try {
			await run();
		} catch (error) {
			toast({ tone: "err", message: t("agents.actionFailed", { reason: ipcErrorMessage(error) }) });
		}
	};

	const reloadFromDisk = async () => {
		setReloading(true);
		await guard(async () => list.setData(await window.vomp.invoke("agents:list", cwd, true)));
		setReloading(false);
	};

	const customize = (agent: AgentEntry) =>
		guard(async () => {
			await window.vomp.invoke("agents:customize", agent.name, "user", cwd);
			const next = await window.vomp.invoke("agents:list", cwd, false);
			list.setData(next);
			const copy = next.agents.find(entry => entry.name === agent.name && entry.scope === "user");
			if (copy) setEditor({ kind: "edit", entry: copy });
			toast({ tone: "ok", message: t("agents.customized", { name: agent.name }) });
		});

	const duplicate = (agent: AgentEntry) =>
		guard(async () => {
			const name = copyName(agent.name, takenNames);
			const scope: AgentWritableScope = agent.scope === "project" ? "project" : "user";
			await window.vomp.invoke(
				"agents:create",
				duplicateAgentDraft(agent, name),
				scope,
				cwd,
			);
			const next = await window.vomp.invoke("agents:list", cwd, false);
			list.setData(next);
			const copy = next.agents.find(entry => entry.name === name);
			if (copy) setEditor({ kind: "edit", entry: copy });
		});

	const setEnabled = (agent: AgentEntry, enabled: boolean) =>
		guard(async () => {
			const result = await window.vomp.invoke("agents:setEnabled", agent.name, enabled, cwd);
			list.setData(
				current =>
					current && {
						...current,
						disabled: result.disabled,
						agents: current.agents.map(entry => (entry.name === agent.name ? { ...entry, enabled: !result.disabled.includes(agent.name) } : entry)),
					},
			);
			if (result.shadowedBy) toast({ tone: "warn", message: t("agents.shadowed", { name: agent.name }) });
		});

	const confirmDelete = (agent: AgentEntry) =>
		guard(async () => {
			if (!agent.filePath) return;
			await window.vomp.invoke("agents:delete", agent.filePath);
			setDeleting(null);
			toast({ tone: "ok", message: t("agents.deleted", { name: agent.name }) });
			await reload();
		});

	const createWithAi = async (description: string, dir: string, scope: AgentWritableScope) => {
		const started = await startChat(tabId => controllerFor(tabId)?.send(createWithAiPrompt(description, dir, scope)));
		if (started) toast({ tone: "info", message: t("agents.ai.started"), description: t("agents.ai.startedHint") });
	};

	return (
		<>
			<PageHeader
				title={t("settings.sections.helpers")}
				description={t("agents.subtitle")}
				actions={
					<>
						<Button icon={<ArrowsClockwise />} loading={reloading} onClick={() => void reloadFromDisk()}>
							{t("agents.refresh")}
						</Button>
						<Button icon={<ChatText />} onClick={() => setAiOpen(true)}>
							{t("agents.createWithAi")}
						</Button>
						<Button variant="primary" icon={<Plus />} onClick={() => setEditor({ kind: "create" })}>
							{t("agents.new")}
						</Button>
					</>
				}
			/>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<SearchInput
					className="min-w-48 flex-1"
					value={query}
					onValueChange={setQuery}
					placeholder={t("agents.search")}
					aria-label={t("agents.search")}
				/>
				<Segmented
					size="sm"
					aria-label={t("agents.filter")}
					value={filter}
					onValueChange={setFilter}
					options={[
						{ value: "all", label: t("agents.filters.all") },
						{ value: "bundled", label: t("agents.scope.bundled") },
						{ value: "user", label: t("agents.scope.user") },
						{ value: "project", label: t("agents.scope.project"), disabled: !projectAvailable },
					]}
				/>
			</div>
			{cwd && snapshot && !projectAvailable && <p className="mb-3 text-sm text-fg-muted">{t("agents.projectUnavailable")}</p>}
			{list.error && !snapshot ? (
				<EmptyState
					icon={<Warning />}
					title={t("agents.loadFailed")}
					body={list.error}
					actions={<Button onClick={() => void reload()}>{t("settings.retry")}</Button>}
				/>
			) : !snapshot ? (
				<div aria-busy>
					{Array.from({ length: 5 }, (_, index) => (
						<Skeleton key={index} height={64} className="my-2" />
					))}
				</div>
			) : visible.length === 0 && errors.length === 0 ? (
				<EmptyState icon={<Wrench />} title={t(query ? "agents.emptySearch" : "agents.empty")} body={query ? undefined : t("agents.emptyBody")} />
			) : (
				<ul aria-label={t("agents.title")} className="relative divide-y divide-border border-y border-border">
					<AnimatePresence initial={false} mode="popLayout">
						{errors.map(error => (
							<ErrorRow key={error.filePath} error={error} onFix={() => setEditor({ kind: "raw", filePath: error.filePath, name: error.name })} />
						))}
						{visible.map(agent => (
							<AgentRow
								key={agent.id}
								agent={agent}
								onToggle={enabled => void setEnabled(agent, enabled)}
								onEdit={() => (agent.scope === "bundled" ? void customize(agent) : setEditor({ kind: "edit", entry: agent }))}
								onDuplicate={() => void duplicate(agent)}
								onRun={() => runNow(agent.name)}
								onDelete={() => setDeleting(agent)}
							/>
						))}
					</AnimatePresence>
				</ul>
			)}

			{editor && (
				<AgentEditor
					target={editor}
					cwd={cwd}
					dirs={snapshot?.dirs ?? null}
					models={models.data}
					takenNames={takenNames}
					// A new helper starts in the place the list shows (This project or All projects), else all projects.
					initialScope={filter === "project" && projectAvailable ? "project" : "user"}
					onClose={() => setEditor(null)}
					onSaved={() => void reload()}
					onTest={name => runNow(name)}
				/>
			)}
			<CreateWithAiDialog open={aiOpen} onOpenChange={setAiOpen} cwd={cwd} dirs={snapshot?.dirs ?? null} onCreate={createWithAi} />
			<Dialog open={deleting !== null} onOpenChange={open => !open && setDeleting(null)}>
				<DialogContent
					destructive
					size="sm"
					title={t("agents.delete.title", { name: deleting?.name })}
					description={t("agents.delete.body")}
					footer={
						<>
							<Button variant="ghost" onClick={() => setDeleting(null)}>
								{t("common.cancel")}
							</Button>
							<Button variant="danger" onClick={() => deleting && void confirmDelete(deleting)}>
								{t("agents.delete.confirm")}
							</Button>
						</>
					}
				/>
			</Dialog>
		</>
	);
}

/** Project scope gets the accent, as in the skills and plugins lists; bundled and user read from the label. */
const SCOPE_TONE: Record<AgentScope, "neutral" | "accent"> = { bundled: "neutral", user: "neutral", project: "accent" };

/** Letter tile standing in for an avatar (same treatment as the skills and plugins lists). */
const letterTile = "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-inset font-mono text-sm font-semibold";

/** Columns shared by helper and broken-file rows: tile, text, model, on/off, actions. */
const rowGrid = "grid grid-cols-[2rem_minmax(0,1fr)_auto_2.75rem_2rem] items-center gap-x-3 px-2 py-3";

function AgentRow({
	agent,
	onToggle,
	onEdit,
	onDuplicate,
	onRun,
	onDelete,
	ref,
}: {
	agent: AgentEntry;
	onToggle(enabled: boolean): void;
	onEdit(): void;
	onDuplicate(): void;
	onRun(): void;
	onDelete(): void;
	/** Set by AnimatePresence (`popLayout`) to measure the row as it leaves. */
	ref?: Ref<HTMLLIElement>;
}) {
	const { t } = useTranslation("manage");
	const model = agent.modelOverride?.[0] ?? agent.model?.[0] ?? null;
	const dim = cn("transition-opacity duration-(--dur)", !agent.enabled && "opacity-50");
	return (
		<motion.li ref={ref} {...listRowMotion} className={cn(rowGrid, "bg-bg")}>
			<span aria-hidden className={cn(letterTile, "uppercase text-fg-muted", dim)}>
				{agent.name.slice(0, 1)}
			</span>
			<div className={cn("min-w-0", dim)}>
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<span className="truncate text-md font-semibold text-fg">{agent.name}</span>
					<Chip tone={SCOPE_TONE[agent.scope]}>{t(`agents.scope.${agent.scope}`)}</Chip>
					{agent.overrides.includes("bundled") && <Chip tone="neutral">{t("agents.customizedChip")}</Chip>}
					{agent.warnings.length > 0 && (
						<Chip tone="warn" icon={<Warning />} title={agent.warnings.join("\n")}>
							{t("agents.warnings", { count: agent.warnings.length })}
						</Chip>
					)}
				</div>
				<p className="mt-1 line-clamp-2 text-sm text-fg-muted" title={agent.description}>
					{agent.description}
				</p>
			</div>
			<span className={cn("flex w-36 justify-end", dim)}>
				<Chip
					tone={agent.modelOverride ? "accent" : "neutral"}
					title={agent.modelOverride ? t("agents.overrideHint") : undefined}
					className="max-w-full truncate"
				>
					{model ? model.split("/").pop() : t("agents.defaultModel")}
				</Chip>
			</span>
			<Switch aria-label={t("agents.enable", { name: agent.name })} checked={agent.enabled} onCheckedChange={onToggle} />
			<Menu>
				<MenuTrigger asChild>
					<IconButton label={t("agents.more", { name: agent.name })} icon={<DotsThree />} />
				</MenuTrigger>
				<MenuContent align="end">
					<MenuItem icon={<PencilSimple />} onSelect={onEdit}>
						{agent.scope === "bundled" ? t("agents.menu.customize") : t("agents.menu.edit")}
					</MenuItem>
					<MenuItem icon={<Copy />} onSelect={onDuplicate}>
						{t("agents.menu.duplicate")}
					</MenuItem>
					<MenuItem icon={<Play />} onSelect={onRun}>
						{t("agents.menu.run")}
					</MenuItem>
					{agent.scope !== "bundled" && (
						<>
							<MenuSeparator />
							<MenuItem icon={<Trash />} danger onSelect={onDelete}>
								{t("agents.menu.delete")}
							</MenuItem>
						</>
					)}
				</MenuContent>
			</Menu>
		</motion.li>
	);
}

function ErrorRow({ error, onFix, ref }: { error: AgentFileError; onFix(): void; ref?: Ref<HTMLLIElement> }) {
	const { t } = useTranslation("manage");
	return (
		<motion.li ref={ref} {...listRowMotion} className="flex items-center gap-3 bg-bg px-2 py-3">
			<span aria-hidden className={cn(letterTile, "bg-warn-bg text-warn")}>
				<Warning className="size-4" />
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-md font-semibold text-fg">{error.name ?? error.filePath.split(/[\\/]/).pop()}</span>
					<Chip tone="warn">{t("agents.brokenChip")}</Chip>
				</div>
				<p className="mt-1 line-clamp-2 text-sm text-fg-muted" title={error.message}>
					{error.message}
				</p>
			</div>
			<Button size="sm" onClick={onFix}>
				{t("agents.fix")}
			</Button>
		</motion.li>
	);
}
