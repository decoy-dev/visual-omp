/** DESIGN §4.15 — MCP servers manager ("Connected tools"). */
import { DotsThree, Eye, Lock, PencilSimple, PlugsConnected, Plus, Trash } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpServerEntry, McpTarget } from "@shared/contracts/mcp";
import type { SheetProps } from "@/registry/slots";
import {
	Button,
	Chip,
	Dialog,
	DialogContent,
	EmptyState,
	IconButton,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	Segmented,
	Skeleton,
	StatusDot,
	Switch,
	Spinner,
	toast,
	Tooltip,
} from "@/ui";
import { listRowMotion } from "@/features/manage/listMotion";
import { errorText } from "../format";
import { ConfirmDialog, type ExtensionSheetProps, ExtensionSheetFrame, Notice, useIpcEvent, useLoad, useSheetProject } from "../shared";
import { endpointOf } from "./form";
import { ServerEditor, type EditorMode } from "./McpEditor";
import { type McpCheck, rowStatus } from "./status";

type Scope = "user" | "project";

/** How many servers are checked at once when the sheet opens (each check may spawn a process). */
const CHECK_CONCURRENCY = 3;

export function targetFor(entry: McpServerEntry, cwd: string | null): McpTarget | null {
	if (!entry.editable) return null;
	if (entry.level === "user") return { scope: "user" };
	return cwd ? { scope: "project", cwd } : null;
}

export function McpSheet({ props, close }: SheetProps<ExtensionSheetProps>) {
	const { t } = useTranslation("extensions");
	const projectPath = useSheetProject(props);
	const list = useLoad(() => window.vomp.invoke("mcp:list", projectPath), [projectPath]);
	useIpcEvent("mcp:changed", () => void list.reload());
	const [scope, setScope] = useState<Scope>(props?.scope === "global" || !projectPath ? "user" : "project");
	const [editor, setEditor] = useState<EditorMode | null>(null);
	const [checks, setChecks] = useState<Record<string, McpCheck>>({});
	const [toolsFor, setToolsFor] = useState<McpServerEntry | null>(null);
	const [removing, setRemoving] = useState<McpServerEntry | null>(null);

	const runCheck = useCallback(
		async (entry: McpServerEntry) => {
			setChecks(prev => ({ ...prev, [entry.id]: { state: "running" } }));
			const result = await window.vomp.invoke("mcp:test", entry.config, projectPath ? { cwd: projectPath } : undefined);
			setChecks(prev => ({ ...prev, [entry.id]: { state: "done", result } }));
			return result;
		},
		[projectPath],
	);

	// Check every server omp would use once per sheet session, a few at a time.
	const autoChecked = useRef(new Set<string>());
	useEffect(() => {
		const pending = (list.data?.servers ?? []).filter(
			entry => entry.enabled && entry.status === "active" && !autoChecked.current.has(entry.id),
		);
		for (const entry of pending) autoChecked.current.add(entry.id);
		let cursor = 0;
		const worker = async () => {
			while (cursor < pending.length) {
				const entry = pending[cursor++];
				if (entry) await runCheck(entry);
			}
		};
		for (let i = 0; i < Math.min(CHECK_CONCURRENCY, pending.length); i++) void worker();
	}, [list.data, runCheck]);

	const rows = useMemo(() => (list.data?.servers ?? []).filter(entry => entry.level === scope), [list.data, scope]);

	const toggle = async (entry: McpServerEntry, enabled: boolean, undo = true) => {
		try {
			await window.vomp.invoke(enabled ? "mcp:enable" : "mcp:disable", entry.name, {
				cwd: projectPath,
				sourcePath: entry.path,
			});
			await list.reload();
			if (enabled && entry.status === "active") void runCheck(entry);
			if (undo) {
				toast({
					tone: "info",
					message: t(enabled ? "mcp.toast.enabled" : "mcp.toast.disabled", { name: entry.name }),
					action: { label: t("common.undo"), onClick: () => void toggle(entry, !enabled, false) },
				});
			}
		} catch (err) {
			toast({ tone: "err", message: t("mcp.toast.toggleFailed", { name: entry.name }), description: errorText(err) });
		}
	};

	const remove = async (entry: McpServerEntry) => {
		const target = targetFor(entry, projectPath);
		if (!target) return;
		await window.vomp.invoke("mcp:remove", target, entry.name);
		toast({ tone: "ok", message: t("mcp.toast.removed", { name: entry.name }) });
	};

	if (editor) {
		return (
			<ServerEditor
				mode={editor}
				close={close}
				projectPath={projectPath}
				list={list.data}
				onBack={() => setEditor(null)}
				onSaved={saved => {
					setEditor(null);
					if (saved) setScope(saved);
				}}
			/>
		);
	}

	return (
		<ExtensionSheetFrame
			close={close}
			width={880}
			title={t("mcp.title")}
			description={t("mcp.subtitle")}
			actions={
				<Button variant="primary" size="sm" icon={<Plus />} onClick={() => setEditor({ kind: "gallery" })}>
					{t("mcp.add")}
				</Button>
			}
			bodyClassName="flex flex-col gap-4"
		>
			<div className="flex items-center justify-between gap-3">
				<Segmented<Scope>
					aria-label={t("mcp.scopeLabel")}
					value={scope}
					onValueChange={setScope}
					options={[
						{ value: "user", label: t("scope.user") },
						{ value: "project", label: t("scope.project"), disabled: !projectPath },
					]}
				/>
				{list.data && (
					<span className="truncate font-mono text-xs text-fg-faint" title={scope === "user" ? list.data.userPath : (list.data.projectPath ?? "")}>
						{scope === "user" ? list.data.userPath : list.data.projectPath}
					</span>
				)}
			</div>

			{list.error && (
				<Notice tone="err" actions={<Button size="sm" onClick={() => void list.reload()}>{t("common.retry")}</Button>}>
					{t("mcp.loadFailed")} {list.error}
				</Notice>
			)}
			{list.data?.warnings.map(warning => (
				<Notice key={warning} tone="warn">
					{/* Service warnings can carry raw validation dumps: show the start, keep the rest one click away. */}
					<details>
						<summary className="line-clamp-2 cursor-pointer">{warning}</summary>
						<pre className="mt-1.5 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap text-fg-muted">{warning}</pre>
					</details>
				</Notice>
			))}
			{scope === "project" && list.data && !list.data.settings.enableProjectConfig && (
				<Notice tone="warn">{t("mcp.projectConfigOff")}</Notice>
			)}

			{!list.data && list.loading ? (
				<div className="flex flex-col gap-2">
					{[0, 1, 2].map(i => (
						<Skeleton key={i} height={56} />
					))}
				</div>
			) : rows.length === 0 ? (
				<EmptyState
					icon={<PlugsConnected />}
					title={t(scope === "user" ? "mcp.empty.userTitle" : "mcp.empty.projectTitle")}
					body={t("mcp.empty.body")}
					actions={
						<Button variant="primary" icon={<Plus />} onClick={() => setEditor({ kind: "gallery" })}>
							{t("mcp.add")}
						</Button>
					}
				/>
			) : (
				<ul className="relative flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel">
					<AnimatePresence initial={false} mode="popLayout">
						{rows.map(entry => (
							<ServerRow
								key={entry.id}
								entry={entry}
								check={checks[entry.id]}
								projectPath={projectPath}
								onToggle={enabled => void toggle(entry, enabled)}
								onTest={() => void runCheck(entry)}
								onEdit={() => setEditor({ kind: "edit", entry })}
								onViewTools={() => {
									setToolsFor(entry);
									if (checks[entry.id]?.state !== "done") void runCheck(entry);
								}}
								onRemove={() => setRemoving(entry)}
							/>
						))}
					</AnimatePresence>
				</ul>
			)}

			<ToolsDialog entry={toolsFor} check={toolsFor ? checks[toolsFor.id] : undefined} onClose={() => setToolsFor(null)} />
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={open => !open && setRemoving(null)}
				title={t("mcp.remove.title", { name: removing?.name ?? "" })}
				description={t("mcp.remove.body", { path: removing?.path ?? "" })}
				confirmLabel={t("mcp.remove.confirm")}
				cancelLabel={t("common.cancel")}
				onConfirm={() => (removing ? remove(removing) : undefined)}
			/>
		</ExtensionSheetFrame>
	);
}

interface ServerRowProps {
	entry: McpServerEntry;
	check: McpCheck | undefined;
	projectPath: string | null;
	onToggle(enabled: boolean): void;
	onTest(): void;
	onEdit(): void;
	onViewTools(): void;
	onRemove(): void;
	/** Set by AnimatePresence (`popLayout`) to measure the row as it leaves. */
	ref?: Ref<HTMLLIElement>;
}

function ServerRow({ entry, check, projectPath, onToggle, onTest, onEdit, onViewTools, onRemove, ref }: ServerRowProps) {
	const { t } = useTranslation("extensions");
	const status = rowStatus(entry, check);
	const writable = targetFor(entry, projectPath) !== null;
	const result = check?.state === "done" ? check.result : null;
	const statusText =
		status.kind === "unused" || status.kind === "invalid"
			? (entry.statusDetail ?? entry.errors[0] ?? t(`mcp.status.${status.kind}`))
			: status.kind === "failed"
				? (result?.error ?? t("mcp.status.failed"))
				: t(`mcp.status.${status.kind}`, { seconds: result ? (result.durationMs / 1000).toFixed(1) : "" });
	const endpoint = endpointOf(entry.config);
	return (
		<motion.li ref={ref} {...listRowMotion} className="flex min-h-14 items-center gap-3 bg-panel px-4 py-2 transition-colors duration-(--dur-fast) hover:bg-hover">
			<Tooltip content={statusText}>
				<span tabIndex={0} className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
					{status.kind === "checking" ? <Spinner size={12} label={statusText} /> : <StatusDot status={status.dot} label={statusText} glyph />}
				</span>
			</Tooltip>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-base font-semibold text-fg">{entry.name}</span>
					{!entry.editable && (
						<Tooltip content={t("mcp.readOnly", { source: entry.providerName, path: entry.path })}>
							<span tabIndex={0} className="inline-flex items-center gap-1 rounded-sm text-xs text-fg-faint focus-visible:outline-2 focus-visible:outline-ring">
								<Lock aria-hidden className="size-3" />
								<span>{t("mcp.fromSource", { source: entry.providerName })}</span>
							</span>
						</Tooltip>
					)}
					{status.kind === "noTools" && <Chip tone="warn">{t("mcp.noTools")}</Chip>}
					{status.kind === "needsSignIn" && <Chip tone="warn">{t("mcp.status.needsSignIn")}</Chip>}
				</div>
				<div className="flex min-w-0 items-center gap-2">
					<Chip tone="neutral" className="h-5 px-2 font-mono">
						{entry.transport}
					</Chip>
					{endpoint && (
						<span className="truncate font-mono text-xs text-fg-muted" title={endpoint}>
							{endpoint}
						</span>
					)}
				</div>
				{status.kind === "failed" && result?.error && (
					<span className="truncate text-xs text-err" title={result.error}>
						{result.error}
					</span>
				)}
			</div>
			<span className="w-16 shrink-0 text-right text-sm tabular-nums text-fg-muted">
				{result?.ok ? t("mcp.toolCount", { count: result.tools.length }) : ""}
			</span>
			<Switch
				checked={entry.enabled}
				onCheckedChange={onToggle}
				aria-label={t(entry.enabled ? "mcp.turnOff" : "mcp.turnOn", { name: entry.name })}
			/>
			<Menu>
				<MenuTrigger asChild>
					<IconButton label={t("mcp.more", { name: entry.name })} icon={<DotsThree />} />
				</MenuTrigger>
				<MenuContent align="end">
					<MenuItem icon={<PlugsConnected />} onSelect={onTest} disabled={check?.state === "running"}>
						{t("mcp.menu.test")}
					</MenuItem>
					<MenuItem icon={<Eye />} onSelect={onViewTools}>
						{t("mcp.menu.tools")}
					</MenuItem>
					<MenuItem icon={<PencilSimple />} onSelect={onEdit} disabled={!writable}>
						{t("mcp.menu.edit")}
					</MenuItem>
					<MenuSeparator />
					<MenuItem icon={<Trash />} danger onSelect={onRemove} disabled={!writable}>
						{t("mcp.menu.remove")}
					</MenuItem>
				</MenuContent>
			</Menu>
		</motion.li>
	);
}

function ToolsDialog({ entry, check, onClose }: { entry: McpServerEntry | null; check: McpCheck | undefined; onClose(): void }) {
	const { t } = useTranslation("extensions");
	const result = check?.state === "done" ? check.result : null;
	return (
		<Dialog open={entry !== null} onOpenChange={open => !open && onClose()}>
			<DialogContent
				size="xl"
				title={t("mcp.tools.title", { name: entry?.name ?? "" })}
				description={result?.serverInfo ? `${result.serverInfo.title ?? result.serverInfo.name} ${result.serverInfo.version}` : undefined}
				footer={<Button onClick={onClose}>{t("common.done")}</Button>}
			>
				{!result ? (
					<div className="flex items-center gap-2 py-6 text-sm text-fg-muted">
						<Spinner /> {t("mcp.test.running")}
					</div>
				) : !result.ok ? (
					<Notice tone="err">{result.error}</Notice>
				) : result.tools.length === 0 ? (
					<Notice tone="warn">{t("mcp.noTools")}</Notice>
				) : (
					<ul className="flex flex-col divide-y divide-border rounded-md border border-border">
						{result.tools.map(tool => (
							<li key={tool.name} className="flex flex-col gap-0.5 px-3 py-2">
								<span className="font-mono text-sm font-medium text-fg">{tool.title ?? tool.name}</span>
								{tool.description && <span className="line-clamp-3 text-sm text-fg-muted">{tool.description}</span>}
							</li>
						))}
					</ul>
				)}
				{result?.ok && (result.prompts.length > 0 || result.resources.length > 0) && (
					<p className="mt-3 text-sm text-fg-muted">
						{t("mcp.tools.extras", { prompts: result.prompts.length, resources: result.resources.length })}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
