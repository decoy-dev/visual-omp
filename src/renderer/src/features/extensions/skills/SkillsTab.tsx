import { Download, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RegistryInstalledSkill, SkillEntry, SkillRegistryResult, SkillSearchHit } from "@shared/contracts/skills";
import {
	BracketLabel,
	Button,
	Chip,
	EmptyState,
	Menu,
	MenuContent,
	MenuItem,
	MenuTrigger,
	Skeleton,
	Switch,
	toast,
	Tooltip,
} from "@/ui";
import { focusRing } from "@/ui/styles";
import { errorText, formatCount } from "../format";
import { ConfirmDialog, LetterTile, Notice, useDebounced, useIpcEvent, useLoad } from "../shared";
import { lockedReason, providerLabel } from "./model";
import { InlineProgress, OperationLog } from "./OperationLog";
import { type Operations, useOperations } from "./operations";
import type { BrowseFilter } from "./SkillsSheet";
import { SkillDrawer } from "./SkillDrawer";

interface TabProps {
	cwd: string;
	projectPath: string | null;
	filter: BrowseFilter;
	query: string;
}

export function SkillsTab({ cwd, projectPath, filter, query }: TabProps) {
	const { t } = useTranslation("extensions");
	const listing = useLoad(() => window.vomp.invoke("skills:list", cwd), [cwd]);
	const installed = useLoad(() => window.vomp.invoke("skills:registry:installed", cwd), [cwd]);
	useIpcEvent("skills:changed", () => {
		void listing.reload();
		void installed.reload();
	});
	const ops = useOperations("skills:progress");
	const [open, setOpen] = useState<SkillEntry | null>(null);
	const [approval, setApproval] = useState<{ id: string; global: boolean } | null>(null);

	const needle = query.trim().toLowerCase();
	const skills = useMemo(
		() =>
			(listing.data?.skills ?? []).filter(
				skill =>
					(filter !== "project" || skill.level === "project") &&
					(!needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle)),
			),
		[listing.data, filter, needle],
	);

	const toggle = async (skill: SkillEntry, enabled: boolean) => {
		if (!skill.toggleName) return;
		try {
			await window.vomp.invoke("skills:setEnabled", skill.toggleName, enabled);
			await listing.reload();
			toast({
				tone: "info",
				message: t(enabled ? "skills.toast.enabled" : "skills.toast.disabled", { name: skill.name }),
				action: {
					label: t("common.undo"),
					onClick: () => void window.vomp.invoke("skills:setEnabled", skill.toggleName ?? skill.name, !enabled).then(() => listing.reload()),
				},
			});
		} catch (err) {
			toast({ tone: "err", message: t("skills.toast.toggleFailed", { name: skill.name }), description: errorText(err) });
		}
	};

	const report = (result: SkillRegistryResult, id: string, success: string) => {
		if (result.ok) toast({ tone: "ok", message: t(success, { name: id }) });
		for (const warning of result.warnings) toast({ tone: "warn", message: warning });
	};

	const install = async (id: string, global: boolean, yes = false) => {
		const result = await ops.start(id, "installing", opId =>
			window.vomp.invoke("skills:registry:install", { cwd, global, specs: [id], yes, opId }),
		);
		if (result.needsScriptApproval) {
			setApproval({ id, global });
			return;
		}
		report(result, id, "skills.toast.installed");
		void installed.reload();
		void listing.reload();
	};

	const uninstall = async (id: string, global: boolean) => {
		const result = await ops.start(id, "removing", opId => window.vomp.invoke("skills:registry:uninstall", { cwd, global, names: [id], opId }));
		report(result, id, "skills.toast.removed");
		void installed.reload();
		void listing.reload();
	};

	return (
		<div className="flex flex-col gap-4">
			{listing.data && !listing.data.skillsEnabled && (
				<Notice
					tone="warn"
					actions={
						<Button
							size="sm"
							onClick={() => void window.vomp.invoke("skills:settings:set", { enabled: true }).then(() => listing.reload())}
						>
							{t("skills.turnOnAll")}
						</Button>
					}
				>
					{t("skills.allOff")}
				</Notice>
			)}
			{listing.error && <Notice tone="err">{listing.error}</Notice>}

			{filter === "registry" ? (
				<RegistryBrowser
					query={query}
					installed={installed.data ?? []}
					projectPath={projectPath}
					runningFor={ops.runningFor}
					onInstall={(id, global) => void install(id, global).catch(err => toast({ tone: "err", message: errorText(err) }))}
					onRemove={(id, global) => void uninstall(id, global).catch(err => toast({ tone: "err", message: errorText(err) }))}
				/>
			) : !listing.data && listing.loading ? (
				<div className="grid grid-cols-3 gap-3">
					{[0, 1, 2, 3, 4, 5].map(i => (
						<Skeleton key={i} height={120} />
					))}
				</div>
			) : skills.length === 0 ? (
				<EmptyState
					icon={<Sparkles />}
					title={needle ? t("skills.noMatch", { q: query.trim() }) : t(filter === "project" ? "skills.emptyProject" : "skills.empty")}
					body={needle ? undefined : t("skills.emptyBody")}
				/>
			) : (
				<ul className="grid grid-cols-3 gap-3">
					{skills.map(skill => (
						<li key={skill.filePath}>
							<SkillCard skill={skill} onOpen={() => setOpen(skill)} onToggle={enabled => void toggle(skill, enabled)} />
						</li>
					))}
				</ul>
			)}

			{filter !== "registry" && (listing.data?.invalid.length ?? 0) > 0 && (
				<Notice tone="warn">
					{t("skills.invalid", { count: listing.data?.invalid.length ?? 0 })}
					<ul className="mt-1 list-disc pl-4">
						{listing.data?.invalid.map(file => (
							<li key={file.filePath} className="truncate">
								<span className="font-mono text-xs">{file.dirName}</span> — {file.issues[0]?.message}
							</li>
						))}
					</ul>
				</Notice>
			)}

			<OperationLog
				ops={ops.list}
				onCancel={opId => void window.vomp.invoke("skills:cancel", opId)}
				onDismiss={ops.dismiss}
			/>

			<SkillDrawer
				skill={open ? (listing.data?.skills.find(s => s.filePath === open.filePath) ?? open) : null}
				onClose={() => setOpen(null)}
				onToggle={(skill, enabled) => void toggle(skill, enabled)}
				onRemove={skill => {
					if (!skill.registry) return;
					setOpen(null);
					void uninstall(skill.registry.id, skill.level === "user");
				}}
			/>

			<ConfirmDialog
				open={approval !== null}
				onOpenChange={next => !next && setApproval(null)}
				destructive={false}
				title={t("skills.scripts.title", { name: approval?.id ?? "" })}
				description={t("skills.scripts.body")}
				confirmLabel={t("skills.scripts.confirm")}
				cancelLabel={t("common.cancel")}
				onConfirm={() => {
					if (!approval) return;
					const { id, global } = approval;
					setApproval(null);
					void install(id, global, true);
				}}
			/>
		</div>
	);
}

function SkillCard({ skill, onOpen, onToggle }: { skill: SkillEntry; onOpen(): void; onToggle(enabled: boolean): void }) {
	const { t } = useTranslation("extensions");
	const locked = lockedReason(skill);
	const toggleLabel = t(skill.enabled ? "skills.turnOff" : "skills.turnOn", { name: skill.name });
	return (
		<div className="vo-card relative flex h-[120px] flex-col gap-1.5 rounded-lg border border-border bg-panel p-3 transition-shadow duration-(--dur-fast) hover:shadow-(--shadow-card)">
			<div className="flex min-w-0 items-center gap-2">
				<LetterTile name={skill.name} className="size-7" />
				<button
					type="button"
					onClick={onOpen}
					className={`min-w-0 flex-1 truncate rounded-sm text-left text-md font-semibold text-fg after:absolute after:inset-0 after:rounded-lg ${focusRing}`}
					title={skill.name}
				>
					{skill.name}
				</button>
			</div>
			<p className="line-clamp-2 text-sm text-fg-muted">{skill.description || t("skills.noDescription")}</p>
			<div className="mt-auto flex items-center gap-1.5">
				<Chip tone={skill.level === "project" ? "accent" : "neutral"}>{t(skill.level === "project" ? "scope.project" : "scope.user")}</Chip>
				<span className="min-w-0 flex-1 truncate text-xs text-fg-faint">{providerLabel(skill.provider)}</span>
				{locked ? (
					<Tooltip content={t(`skills.reason.${locked}`)}>
						<span tabIndex={0} className={`relative z-10 rounded-full ${focusRing}`}>
							<Switch checked={skill.enabled} disabled aria-label={toggleLabel} />
						</span>
					</Tooltip>
				) : (
					<Switch className="relative z-10" checked={skill.enabled} onCheckedChange={onToggle} aria-label={toggleLabel} />
				)}
			</div>
		</div>
	);
}

interface RegistryBrowserProps {
	query: string;
	installed: RegistryInstalledSkill[];
	projectPath: string | null;
	runningFor: Operations["runningFor"];
	onInstall(id: string, global: boolean): void;
	onRemove(id: string, global: boolean): void;
}

function RegistryBrowser({ query, installed, projectPath, runningFor, onInstall, onRemove }: RegistryBrowserProps) {
	const { t } = useTranslation("extensions");
	const settled = useDebounced(query.trim(), 300);
	const search = useLoad(() => window.vomp.invoke("skills:registry:search", settled, settled ? "relevance" : "downloads"), [settled]);
	const installedById = useMemo(() => {
		const map = new Map<string, RegistryInstalledSkill[]>();
		for (const entry of installed) map.set(entry.id, [...(map.get(entry.id) ?? []), entry]);
		return map;
	}, [installed]);

	const row = (id: string, description: string, meta: string | null, deprecated: string | null) => {
		const records = installedById.get(id) ?? [];
		const running = runningFor(id);
		return (
			<li key={id} className="flex items-center gap-3 px-3 py-2.5">
				<LetterTile name={id.split("/").pop() ?? id} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						<span className="truncate font-mono text-sm font-semibold text-fg">{id}</span>
						{deprecated && <Chip tone="warn">{t("skills.deprecated")}</Chip>}
						{records.map(record => (
							<Chip key={record.manifestPath} tone="ok">
								{t(record.scope === "project" ? "skills.installedProject" : "skills.installedUser", { version: record.version ?? record.range ?? "" })}
							</Chip>
						))}
					</div>
					{running ? <InlineProgress op={running} /> : <p className="line-clamp-2 text-sm text-fg-muted">{description}</p>}
				</div>
				{meta && <span className="shrink-0 text-xs text-fg-faint">{meta}</span>}
				{records.length > 0 ? (
					<Button
						size="sm"
						variant="danger-ghost"
						icon={<Trash2 />}
						disabled={Boolean(running)}
						onClick={() => onRemove(id, records[0]?.scope === "user")}
						aria-label={t("skills.removeNamed", { name: id })}
					>
						{t("common.remove")}
					</Button>
				) : (
					<Menu>
						<MenuTrigger asChild>
							<Button size="sm" icon={<Download />} disabled={Boolean(running)} aria-label={t("skills.installNamed", { name: id })}>
								{t("common.install")}
							</Button>
						</MenuTrigger>
						<MenuContent align="end">
							<MenuItem onSelect={() => onInstall(id, true)}>{t("skills.installFor.user")}</MenuItem>
							<MenuItem disabled={!projectPath} onSelect={() => onInstall(id, false)}>
								{t("skills.installFor.project")}
							</MenuItem>
						</MenuContent>
					</Menu>
				)}
			</li>
		);
	};

	return (
		<section aria-label={t("skills.registryTitle")} className="flex flex-col gap-3">
			<BracketLabel as="h3">{t("skills.registryTitle")}</BracketLabel>
			{search.error && <Notice tone="warn">{t("skills.offline")}</Notice>}
			{search.error ? (
				installed.length === 0 ? (
					<EmptyState icon={<Sparkles />} title={t("skills.noRegistryInstalls")} />
				) : (
					<ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-panel">
						{installed.map(entry => row(entry.id, "", entry.version ? `v${entry.version}` : null, null))}
					</ul>
				)
			) : !search.data ? (
				<div className="flex flex-col gap-2">
					{[0, 1, 2, 3].map(i => (
						<Skeleton key={i} height={56} />
					))}
				</div>
			) : search.data.hits.length === 0 ? (
				<EmptyState icon={<Sparkles />} title={t("skills.noMatch", { q: settled })} />
			) : (
				<ul className={`flex flex-col divide-y divide-border rounded-lg border border-border bg-panel ${search.loading ? "opacity-70" : ""}`}>
					{search.data.hits.map((hit: SkillSearchHit) =>
						row(hit.id, hit.description, t("skills.weekly", { count: hit.weeklyDownloads, formatted: formatCount(hit.weeklyDownloads) }), hit.deprecated),
					)}
				</ul>
			)}
		</section>
	);
}
