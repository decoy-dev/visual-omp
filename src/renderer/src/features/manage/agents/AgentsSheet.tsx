/** Helpers hub (DESIGN §4.14): omp task agents — bundled and custom — with toggles, overrides and an editor. */
import type { AgentEntry, AgentFileError, AgentScope, AgentWritableScope } from "@shared/contracts/agents";
import { Copy, MoreHorizontal, Pencil, Play, Plus, RefreshCw, Sparkles, Trash2, TriangleAlert, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useComposerDrafts } from "@/chat/composer/drafts";
import type { SheetProps } from "@/registry/slots";
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
	PulseDot,
	SearchInput,
	Segmented,
	Skeleton,
	Switch,
	toast,
} from "@/ui";
import { ModalSheet } from "../ModalSheet";
import { ipcErrorMessage, useResource, useSheetProject } from "../shared";
import { AgentEditor, type EditorTarget } from "./AgentEditor";
import { copyName, createWithAiPrompt } from "./agentsModel";
import { CreateWithAiDialog } from "./CreateWithAiDialog";
import { useRunningAgents } from "./useLiveChats";

export interface AgentsSheetProps {
	projectPath?: string | null;
	/** Initial filter: `project` = this project's helpers, `global` = all-projects helpers; default shows all. */
	scope?: "global" | "project";
}

type Filter = "all" | AgentScope;

export function AgentsSheet({ props, close }: SheetProps<AgentsSheetProps | undefined>) {
	const { t } = useTranslation("manage");
	const cwd = useSheetProject(props?.projectPath);
	const list = useResource(() => window.vomp.invoke("agents:list", cwd, false), [cwd]);
	const models = useResource(() => window.vomp.invoke("config:models", cwd ?? undefined), [cwd]);
	const [filter, setFilter] = useState<Filter>(props?.scope === "project" ? "project" : props?.scope === "global" ? "user" : "all");
	const [query, setQuery] = useState("");
	const [editor, setEditor] = useState<EditorTarget | null>(null);
	const [aiOpen, setAiOpen] = useState(false);
	const [deleting, setDeleting] = useState<AgentEntry | null>(null);
	const running = useRunningAgents(t("agents.untitledChat"));
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
	const takenNames = useMemo(() => new Set(snapshot?.agents.map(agent => agent.name) ?? []), [snapshot]);
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const visible = (snapshot?.agents ?? []).filter(
		agent =>
			agent.active &&
			(filter === "all" || agent.scope === filter) &&
			words.every(word => `${agent.name} ${agent.description}`.toLowerCase().includes(word)),
	);
	const errors = (snapshot?.errors ?? []).filter(error => filter === "all" || error.scope === filter);

	const startChat = (build: (tabId: string) => void | Promise<void>) => {
		if (!cwd) {
			toast({ tone: "warn", message: t("agents.needsProject") });
			return false;
		}
		const tabId = useApp.getState().newChat(cwd);
		if (!tabId) return false;
		void build(tabId);
		close();
		return true;
	};
	const runNow = (name: string) => startChat(tabId => useComposerDrafts.getState().insert(tabId, `Use the ${name} agent to `));

	const guard = async (run: () => Promise<unknown>) => {
		try {
			await run();
		} catch (error) {
			toast({ tone: "err", message: t("agents.actionFailed", { reason: ipcErrorMessage(error) }) });
		}
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
				{
					name,
					description: agent.description,
					systemPrompt: agent.systemPrompt,
					tools: agent.tools?.filter(tool => tool !== "yield"),
					spawns: agent.spawns,
					model: agent.model,
					thinkingLevel: agent.thinkingLevel,
					output: agent.output,
					blocking: agent.blocking,
					autoloadSkills: agent.autoloadSkills,
					readSummarize: agent.readSummarize,
					prewalk: agent.prewalk,
					advisor: agent.advisor,
				},
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
			list.setData(current => current && { ...current, disabled: result.disabled, agents: current.agents.map(entry => (entry.name === agent.name ? { ...entry, enabled: !result.disabled.includes(agent.name) } : entry)) });
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
		const started = startChat(tabId => controllerFor(tabId)?.send(createWithAiPrompt(description, dir, scope)));
		if (started) toast({ tone: "info", message: t("agents.ai.started"), description: t("agents.ai.startedHint") });
	};

	return (
		<ModalSheet
			onClose={close}
			width={960}
			height={640}
			closeLabel={t("common.close")}
			title={t("agents.title")}
			description={t("agents.subtitle")}
			actions={
				<>
					<IconButton
						label={t("agents.refresh")}
						icon={<RefreshCw />}
						onClick={() => void guard(async () => list.setData(await window.vomp.invoke("agents:list", cwd, true)))}
					/>
					<Button icon={<Sparkles />} onClick={() => setAiOpen(true)}>
						{t("agents.createWithAi")}
					</Button>
					<Button variant="primary" icon={<Plus />} onClick={() => setEditor({ kind: "create" })}>
						{t("agents.new")}
					</Button>
				</>
			}
		>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
					<SearchInput className="w-64" value={query} onValueChange={setQuery} placeholder={t("agents.search")} aria-label={t("agents.search")} />
					<Segmented
						size="sm"
						aria-label={t("agents.filter")}
						value={filter}
						onValueChange={setFilter}
						options={[
							{ value: "all", label: t("agents.filters.all") },
							{ value: "bundled", label: t("agents.scope.bundled") },
							{ value: "user", label: t("agents.scope.user") },
							{ value: "project", label: t("agents.scope.project"), disabled: !cwd },
						]}
					/>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
					{list.error && !snapshot ? (
						<EmptyState icon={<TriangleAlert />} title={t("agents.loadFailed")} body={list.error} actions={<Button onClick={() => void reload()}>{t("settings.retry")}</Button>} />
					) : !snapshot ? (
						Array.from({ length: 5 }, (_, index) => <Skeleton key={index} height={56} className="my-2" />)
					) : visible.length === 0 && errors.length === 0 ? (
						<EmptyState icon={<Wrench />} title={t(query ? "agents.emptySearch" : "agents.empty")} body={query ? undefined : t("agents.emptyBody")} />
					) : (
						<ul aria-label={t("agents.title")}>
							{errors.map(error => (
								<ErrorRow key={error.filePath} error={error} onFix={() => setEditor({ kind: "raw", filePath: error.filePath, name: error.name })} />
							))}
							{visible.map(agent => (
								<AgentRow
									key={agent.id}
									agent={agent}
									runningIn={running.get(agent.name) ?? []}
									onToggle={enabled => void setEnabled(agent, enabled)}
									onEdit={() => (agent.scope === "bundled" ? void customize(agent) : setEditor({ kind: "edit", entry: agent }))}
									onDuplicate={() => void duplicate(agent)}
									onRun={() => runNow(agent.name)}
									onDelete={() => setDeleting(agent)}
								/>
							))}
						</ul>
					)}
				</div>
			</div>

			{editor && (
				<AgentEditor
					target={editor}
					cwd={cwd}
					dirs={snapshot?.dirs ?? null}
					models={models.data}
					takenNames={takenNames}
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
		</ModalSheet>
	);
}

const SCOPE_TONE: Record<AgentScope, "neutral" | "accent" | "blue"> = { bundled: "neutral", user: "accent", project: "blue" };

function AgentRow({
	agent,
	runningIn,
	onToggle,
	onEdit,
	onDuplicate,
	onRun,
	onDelete,
}: {
	agent: AgentEntry;
	runningIn: string[];
	onToggle(enabled: boolean): void;
	onEdit(): void;
	onDuplicate(): void;
	onRun(): void;
	onDelete(): void;
}) {
	const { t } = useTranslation("manage");
	const model = agent.modelOverride?.[0] ?? agent.model?.[0] ?? null;
	return (
		<li className="flex h-16 items-center gap-3 rounded-md px-2 hover:bg-hover">
			<div className={cn("flex min-w-0 flex-1 items-center gap-3", !agent.enabled && "opacity-40")}>
				<span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-agent-muted text-md font-semibold uppercase text-agent">
					{agent.name.slice(0, 1)}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2">
						<span className="truncate text-base font-semibold text-fg">{agent.name}</span>
						<Chip tone={SCOPE_TONE[agent.scope]}>{t(`agents.scope.${agent.scope}`)}</Chip>
						{agent.overrides.includes("bundled") && <Chip tone="neutral">{t("agents.customizedChip")}</Chip>}
						{agent.warnings.length > 0 && (
							<Chip tone="warn" icon={<TriangleAlert />} title={agent.warnings.join("\n")}>
								{t("agents.warnings", { count: agent.warnings.length })}
							</Chip>
						)}
						{runningIn.length > 0 && (
							<span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
								<PulseDot label={t("agents.running")} />
								<span className="truncate">{t("agents.runningIn", { title: runningIn[0], count: runningIn.length })}</span>
							</span>
						)}
					</div>
					<p className="truncate text-sm text-fg-muted" title={agent.description}>
						{agent.description}
					</p>
				</div>
				<span className="flex min-w-0 max-w-48 shrink-0">
					<Chip tone={agent.modelOverride ? "accent" : "neutral"} title={agent.modelOverride ? t("agents.overrideHint") : undefined}>
						{model ? model.split("/").pop() : t("agents.defaultModel")}
					</Chip>
				</span>
			</div>
			<Switch aria-label={t("agents.enable", { name: agent.name })} checked={agent.enabled} onCheckedChange={onToggle} />
			<Menu>
				<MenuTrigger asChild>
					<IconButton label={t("agents.more", { name: agent.name })} icon={<MoreHorizontal />} />
				</MenuTrigger>
				<MenuContent align="end">
					<MenuItem icon={<Pencil />} onSelect={onEdit}>
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
							<MenuItem icon={<Trash2 />} danger onSelect={onDelete}>
								{t("agents.menu.delete")}
							</MenuItem>
						</>
					)}
				</MenuContent>
			</Menu>
		</li>
	);
}

function ErrorRow({ error, onFix }: { error: AgentFileError; onFix(): void }) {
	const { t } = useTranslation("manage");
	return (
		<li className="flex h-16 items-center gap-3 rounded-md px-2">
			<span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-warn-bg text-warn">
				<TriangleAlert className="size-4" />
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-base font-semibold text-fg">{error.name ?? error.filePath.split(/[\\/]/).pop()}</span>
					<Chip tone="warn">{t("agents.brokenChip")}</Chip>
				</div>
				<p className="truncate text-sm text-fg-muted" title={error.message}>
					{error.message}
				</p>
			</div>
			<Button size="sm" onClick={onFix}>
				{t("agents.fix")}
			</Button>
		</li>
	);
}
