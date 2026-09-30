/** DESIGN §4.17 — Memory viewer ("What omp remembers"). */
import { Brain, DownloadSimple, Lock, Trash } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryEntrySummary, MemoryScope, MemoryStatus } from "@shared/contracts/memory";
import { listRowMotion } from "@/features/manage/listMotion";
import type { SheetProps } from "@/registry/slots";
import { Markdown } from "@/transcript/Markdown";
import { Button, Chip, cn, EmptyState, PresenceSwap, SearchInput, Select, SelectItem, Skeleton, toast, Tooltip } from "@/ui";
import { focusRingInset } from "@/ui/styles";
import { errorText, formatAge } from "../format";
import { ConfirmDialog, type ExtensionSheetProps, ExtensionSheetFrame, Notice, useDebounced, useLoad, useSheetProject } from "../shared";

const LIST_LIMIT = 200;
/** Word the user types to confirm "Forget everything". */
const CONFIRM_WORD = "forget";

interface Places {
	status: MemoryStatus;
	scopes: MemoryScope[];
	/** Scope ids the active backend reads for this project. */
	projectScopeIds: string[];
}

async function loadPlaces(projectPath: string | null): Promise<Places> {
	const [status, scopes, forProject] = await Promise.all([
		window.vomp.invoke("memory:status"),
		window.vomp.invoke("memory:scopes"),
		projectPath ? window.vomp.invoke("memory:forProject", projectPath) : Promise.resolve([]),
	]);
	const known = new Set(scopes.map(scope => scope.id));
	// The project's scopes come first; ones not created yet are still worth listing (empty).
	const merged = [...forProject.filter(scope => !known.has(scope.id)), ...scopes];
	return { status, scopes: merged, projectScopeIds: forProject.map(scope => scope.id) };
}

function defaultScope(places: Places, preferGlobal: boolean): string | null {
	const { scopes, projectScopeIds } = places;
	if (preferGlobal) {
		const shared = scopes.find(scope => scope.global);
		if (shared) return shared.id;
	}
	const project = scopes.find(scope => projectScopeIds.includes(scope.id) && scope.exists && scope.entryCount > 0);
	return (project ?? scopes.find(scope => projectScopeIds.includes(scope.id)) ?? scopes.find(scope => scope.active) ?? scopes[0])?.id ?? null;
}

export function MemorySheet({ props, close }: SheetProps<ExtensionSheetProps>) {
	const { t, i18n } = useTranslation("extensions");
	const projectPath = useSheetProject(props);
	const places = useLoad(() => loadPlaces(projectPath), [projectPath]);
	const [scopeId, setScopeId] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const settled = useDebounced(query.trim(), 250);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [forgetOne, setForgetOne] = useState<MemoryEntrySummary | null>(null);
	const [forgetAll, setForgetAll] = useState(false);

	useEffect(() => {
		if (places.data && !scopeId) setScopeId(defaultScope(places.data, props?.scope === "global"));
	}, [places.data, scopeId, props?.scope]);

	const scope = places.data?.scopes.find(entry => entry.id === scopeId) ?? null;
	const entries = useLoad(async () => {
		// Which scope and search this result is for: a new pair is a new list, a reload (after forgetting) is not.
		const key = `${scope?.id ?? ""}|${settled}`;
		const result = scope?.exists
			? await window.vomp.invoke("memory:list", scope.id, { query: settled || undefined, limit: LIST_LIMIT })
			: { entries: [], total: 0 };
		return { ...result, key };
	}, [scope?.id, scope?.exists, settled]);
	const list = entries.data?.entries ?? [];
	useEffect(() => {
		if (list.length && !list.some(entry => entry.id === selectedId)) setSelectedId(list[0]?.id ?? null);
		if (!list.length) setSelectedId(null);
	}, [list, selectedId]);
	const selected = list.find(entry => entry.id === selectedId) ?? null;
	const deletableCount = list.filter(entry => entry.deletable).length;

	const forget = async (entry: MemoryEntrySummary) => {
		await window.vomp.invoke("memory:delete", entry.id);
		toast({
			tone: "ok",
			message: t("memory.toast.forgotOne", { name: entry.title }),
			description: entry.backend === "mnemopi" ? t("memory.toast.restartHint") : undefined,
		});
		await Promise.all([entries.reload(), places.reload()]);
	};

	const forgetEverything = async () => {
		if (!scope) return;
		// The list may be filtered or capped: fetch the whole scope before deleting.
		const all = await window.vomp.invoke("memory:list", scope.id, { limit: Math.max(LIST_LIMIT, scope.entryCount) });
		const targets = all.entries.filter(entry => entry.deletable);
		let failed = 0;
		for (const entry of targets) {
			try {
				await window.vomp.invoke("memory:delete", entry.id);
			} catch {
				failed++;
			}
		}
		await Promise.all([entries.reload(), places.reload()]);
		if (failed) throw new Error(t("memory.forgetAll.partial", { failed, count: targets.length }));
		toast({ tone: "ok", message: t("memory.toast.forgotAll", { count: targets.length }) });
	};

	const exportEntry = async (entry: MemoryEntrySummary) => {
		try {
			const full = await window.vomp.invoke("memory:read", entry.id);
			const name = `${entry.title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "memory"}.md`;
			const saved = await window.vomp.invoke("extensions:saveText", {
				title: t("memory.export"),
				defaultName: name,
				content: full.text,
				filters: [{ name: "Markdown", extensions: ["md"] }],
			});
			if (saved) toast({ tone: "ok", message: t("memory.toast.exported"), action: { label: t("common.showInFolder"), onClick: () => void window.vomp.invoke("app:showItem", saved) } });
		} catch (err) {
			toast({ tone: "err", message: t("memory.toast.exportFailed"), description: errorText(err) });
		}
	};

	const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const index = list.findIndex(entry => entry.id === selectedId);
		const next = list[Math.min(list.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
		if (!next) return;
		setSelectedId(next.id);
		event.currentTarget.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.focus();
	};

	const status = places.data?.status;
	return (
		<ExtensionSheetFrame
			close={close}
			width={800}
			title={
				<span className="flex items-center gap-2">
					{t("memory.title")}
					{status && <Chip tone={status.enabled ? "accent" : "neutral"}>{t(`memory.backend.${status.backend}`)}</Chip>}
				</span>
			}
			description={t("memory.subtitle")}
			bodyClassName="flex flex-col gap-3 overflow-hidden"
		>
			{places.error && (
				<Notice tone="err" actions={<Button size="sm" onClick={() => void places.reload()}>{t("common.retry")}</Button>}>
					{t("memory.loadFailed")} {places.error}
				</Notice>
			)}
			{status?.backend === "off" && <Notice tone="info">{t("memory.off")}</Notice>}
			{status?.backend === "hindsight" && <Notice tone="info">{t("memory.remote", { url: status.hindsight.apiUrl })}</Notice>}

			<div className="flex items-center gap-2">
				{places.data && places.data.scopes.length > 0 && (
					<Select value={scopeId ?? undefined} onValueChange={id => setScopeId(id)} aria-label={t("memory.scopeLabel")} className="w-[240px]" size="sm">
						{places.data.scopes.map(entry => (
							<SelectItem key={entry.id} value={entry.id} hint={entry.exists ? String(entry.entryCount) : undefined}>
								{scopeLabel(entry, places.data?.projectScopeIds ?? [], t)}
							</SelectItem>
						))}
					</Select>
				)}
				<SearchInput size="sm" value={query} onValueChange={setQuery} placeholder={t("memory.search")} aria-label={t("memory.search")} className="flex-1" />
				<Button
					size="sm"
					variant="danger"
					icon={<Trash />}
					disabled={!scope || deletableCount === 0}
					onClick={() => setForgetAll(true)}
				>
					{t("memory.forgetAll.action")}
				</Button>
			</div>

			{entries.error && (
				<Notice tone="err">
					{entries.error}{" "}
					{scope && (
						<button type="button" className="font-mono text-xs underline" onClick={() => void window.vomp.invoke("app:showItem", scope.path)}>
							{scope.path}
						</button>
					)}
				</Notice>
			)}
			{scope && list.length > 0 && deletableCount === 0 && (
				<Notice tone="info">
					<span className="inline-flex items-center gap-1.5">
						<Lock aria-hidden className="size-3.5" />
						{t("memory.readOnly")}
					</span>
				</Notice>
			)}

			{!places.data && places.loading ? (
				<Skeleton height={320} />
			) : list.length === 0 && !entries.loading ? (
				<EmptyState
					icon={<Brain />}
					title={settled ? t("memory.noMatch", { q: settled }) : t("memory.empty")}
				/>
			) : (
				<div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-panel">
					<ul
						// A new scope or search is a new list: remount it so its rows show at rest; only forgotten rows animate out.
						key={entries.data?.key ?? ""}
						aria-label={t("memory.listLabel")}
						onKeyDown={onListKey}
						className="relative w-[280px] shrink-0 overflow-y-auto border-r border-border"
					>
						<AnimatePresence initial={false} mode="popLayout">
						{list.map(entry => (
							<motion.li key={entry.id} {...listRowMotion} className="bg-panel">
								<button
									type="button"
									data-id={entry.id}
									aria-current={entry.id === selectedId ? "true" : undefined}
									tabIndex={entry.id === selectedId ? 0 : -1}
									onClick={() => setSelectedId(entry.id)}
									className={cn(
										"relative flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-left transition-colors duration-(--dur-fast) hover:bg-hover",
										entry.id === selectedId && "bg-selected hover:bg-selected",
										focusRingInset,
									)}
								>
									<span className="flex items-center gap-2">
										<span className="min-w-0 flex-1 truncate text-md font-medium text-fg">{entry.title}</span>
										<span className="shrink-0 text-xs text-fg-faint">
											{formatAge(entry.updatedAt ?? entry.createdAt ?? Date.now(), Date.now(), i18n.language)}
										</span>
									</span>
									<span className="line-clamp-1 text-sm text-fg-muted">{entry.preview}</span>
								</button>
							</motion.li>
						))}
						</AnimatePresence>
						{entries.data && entries.data.total > list.length && (
							<li className="px-3 py-2 text-xs text-fg-faint">{t("memory.more", { count: entries.data.total - list.length })}</li>
						)}
					</ul>
					<div className="relative min-w-0 flex-1 overflow-y-auto">
						{selected && (
							<PresenceSwap swapKey={selected.id} mode="popLayout">
								<Reader
									entry={selected}
									onForget={() => setForgetOne(selected)}
									onExport={() => void exportEntry(selected)}
								/>
							</PresenceSwap>
						)}
					</div>
				</div>
			)}

			<ConfirmDialog
				open={forgetOne !== null}
				onOpenChange={open => !open && setForgetOne(null)}
				title={t("memory.forgetOne.title", { name: forgetOne?.title ?? "" })}
				description={t("memory.forgetOne.body")}
				confirmLabel={t("memory.forgetOne.confirm")}
				cancelLabel={t("common.cancel")}
				onConfirm={() => (forgetOne ? forget(forgetOne) : undefined)}
			/>
			<ConfirmDialog
				open={forgetAll}
				onOpenChange={setForgetAll}
				title={t("memory.forgetAll.title")}
				description={t("memory.forgetAll.body", { count: scope?.entryCount ?? deletableCount, scope: scope ? scopeLabel(scope, places.data?.projectScopeIds ?? [], t) : "" })}
				confirmLabel={t("memory.forgetAll.confirm")}
				cancelLabel={t("common.cancel")}
				typeToConfirm={CONFIRM_WORD}
				typeLabel={t("memory.forgetAll.typeLabel", { word: CONFIRM_WORD })}
				onConfirm={forgetEverything}
			>
				{list.length > deletableCount && <p className="text-sm text-fg-muted">{t("memory.forgetAll.keeps")}</p>}
			</ConfirmDialog>
		</ExtensionSheetFrame>
	);
}

function scopeLabel(scope: MemoryScope, projectScopeIds: readonly string[], t: (key: string, options?: Record<string, unknown>) => string): string {
	const where = scope.global ? t("memory.scope.shared") : projectScopeIds.includes(scope.id) ? t("scope.project") : scope.name;
	return `${where} · ${t(`memory.backend.${scope.backend}`)}`;
}

function Reader({ entry, onForget, onExport }: { entry: MemoryEntrySummary; onForget(): void; onExport(): void }) {
	const { t, i18n } = useTranslation("extensions");
	const full = useLoad(() => window.vomp.invoke("memory:read", entry.id), [entry.id]);
	const date = (at: number | null) => (at ? new Date(at).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" }) : null);
	const meta = useMemo(
		() =>
			Object.entries(full.data?.metadata ?? {})
				.filter(([, value]) => value !== null && typeof value !== "object")
				.slice(0, 8),
		[full.data],
	);
	const created = date(entry.createdAt);
	const updated = date(entry.updatedAt);
	return (
		<article className="flex flex-col gap-3 p-4">
			<header className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<h3 className="truncate text-lg font-semibold text-fg">{entry.title}</h3>
					<p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-faint">
						<span>{t(`memory.kind.${entry.kind}`)}</span>
						{created && <span>{t("memory.created", { date: created })}</span>}
						{updated && updated !== created && <span>{t("memory.updated", { date: updated })}</span>}
					</p>
				</div>
				<Button size="sm" variant="ghost" icon={<DownloadSimple />} onClick={onExport}>
					{t("memory.export")}
				</Button>
				{entry.deletable ? (
					<Button size="sm" variant="danger-ghost" icon={<Trash />} onClick={onForget}>
						{t("memory.forgetOne.action")}
					</Button>
				) : (
					<Tooltip content={t("memory.cantDelete")}>
						<span tabIndex={0} className="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-ring">
							<Button size="sm" variant="danger-ghost" icon={<Trash />} disabled>
								{t("memory.forgetOne.action")}
							</Button>
						</span>
					</Tooltip>
				)}
			</header>
			{entry.tags.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{entry.tags.map(tag => (
						<Chip key={tag} tone="neutral">
							{tag}
						</Chip>
					))}
				</div>
			)}
			{full.error ? (
				<Notice tone="err">{full.error}</Notice>
			) : full.data ? (
				<div className="text-md">
					<Markdown text={full.data.text} />
				</div>
			) : (
				<Skeleton height={160} />
			)}
			{meta.length > 0 && (
				<dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md bg-inset p-3 text-xs">
					{meta.map(([key, value]) => (
						<div key={key} className="contents">
							<dt className="font-mono text-fg-faint">{key}</dt>
							<dd className="truncate font-mono text-fg-muted">{String(value)}</dd>
						</div>
					))}
				</dl>
			)}
			<button type="button" className="self-start break-all text-left font-mono text-xs text-fg-faint underline-offset-2 hover:underline" onClick={() => void window.vomp.invoke("app:showItem", entry.path)}>
				{entry.path}
			</button>
		</article>
	);
}
