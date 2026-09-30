import { CircleArrowUp, Download, Package, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AvailablePlugin, MarketplacePlugin, NpmPlugin, PluginOperationResult, PluginScope } from "@shared/contracts/plugins";
import { BracketLabel, Button, Chip, EmptyState, Input, Menu, MenuContent, MenuItem, MenuTrigger, Skeleton, Switch, toast } from "@/ui";
import { compareVersions, errorText } from "../format";
import { LetterTile, Notice, useIpcEvent, useLoad } from "../shared";
import { InlineProgress, OperationLog } from "./OperationLog";
import { type Operation, useOperations } from "./operations";
import type { BrowseFilter } from "./SkillsSheet";

interface TabProps {
	cwd: string;
	projectPath: string | null;
	filter: BrowseFilter;
	query: string;
}

type Installed = NpmPlugin | MarketplacePlugin;

function matches(needle: string, ...fields: (string | null)[]): boolean {
	return !needle || fields.some(field => field?.toLowerCase().includes(needle));
}

export function PluginsTab({ cwd, projectPath, filter, query }: TabProps) {
	const { t } = useTranslation("extensions");
	const listing = useLoad(() => window.vomp.invoke("plugins:list", cwd), [cwd]);
	const catalog = useLoad(() => window.vomp.invoke("plugins:discover", undefined, cwd), [cwd]);
	useIpcEvent("plugins:changed", () => {
		void listing.reload();
		void catalog.reload();
	});
	const ops = useOperations("plugins:progress");
	const [spec, setSpec] = useState("");
	const needle = query.trim().toLowerCase();

	/** Newest catalog version per marketplace id, for "update available". */
	const latest = useMemo(() => new Map((catalog.data ?? []).map(entry => [entry.id, entry.version])), [catalog.data]);

	const installed = useMemo<Installed[]>(() => {
		const all: Installed[] = [...(listing.data?.npm ?? []), ...(listing.data?.marketplace ?? [])];
		return all.filter(
			plugin =>
				(filter !== "project" || (plugin.kind === "marketplace" && plugin.scope === "project")) &&
				matches(needle, plugin.name, plugin.kind === "npm" ? plugin.description : plugin.marketplace),
		);
	}, [listing.data, filter, needle]);

	const run = async (subject: string, verb: string, invoke: (opId: string) => Promise<PluginOperationResult>, success: string) => {
		try {
			const result = await ops.start(subject, verb, invoke);
			if (result.ok) toast({ tone: "ok", message: t(success, { name: subject }) });
			void listing.reload();
			void catalog.reload();
			return result.ok;
		} catch (err) {
			toast({ tone: "err", message: t("ops.failed", { name: subject }), description: errorText(err) });
			return false;
		}
	};

	const install = (target: string, scope?: PluginScope) =>
		run(target, "installing", opId => window.vomp.invoke("plugins:install", { spec: target, scope, cwd, opId }), "plugins.toast.installed");

	const remove = (plugin: Installed) =>
		run(
			plugin.kind === "npm" ? plugin.name : plugin.id,
			"removing",
			opId =>
				window.vomp.invoke("plugins:uninstall", {
					name: plugin.kind === "npm" ? plugin.name : plugin.id,
					scope: plugin.kind === "marketplace" ? plugin.scope : undefined,
					cwd,
					opId,
				}),
			"plugins.toast.removed",
		);

	const upgrade = (plugin: MarketplacePlugin) =>
		run(plugin.id, "updating", opId => window.vomp.invoke("plugins:upgrade", { id: plugin.id, scope: plugin.scope, cwd, opId }), "plugins.toast.updated");

	const toggle = async (plugin: Installed, enabled: boolean) => {
		const name = plugin.kind === "npm" ? plugin.name : plugin.id;
		try {
			await window.vomp.invoke("plugins:setEnabled", name, enabled, { scope: plugin.kind === "marketplace" ? plugin.scope : undefined, cwd });
			await listing.reload();
			toast({
				tone: "info",
				message: t(enabled ? "plugins.toast.enabled" : "plugins.toast.disabled", { name: plugin.name }),
				action: {
					label: t("common.undo"),
					onClick: () =>
						void window.vomp
							.invoke("plugins:setEnabled", name, !enabled, { scope: plugin.kind === "marketplace" ? plugin.scope : undefined, cwd })
							.then(() => listing.reload()),
				},
			});
		} catch (err) {
			toast({ tone: "err", message: t("plugins.toast.toggleFailed", { name: plugin.name }), description: errorText(err) });
		}
	};

	const available = (catalog.data ?? []).filter(entry => matches(needle, entry.name, entry.description, entry.marketplace));

	return (
		<div className="flex flex-col gap-4">
			{listing.error && <Notice tone="err">{listing.error}</Notice>}

			{filter === "registry" ? (
				<>
					<form
						className="flex items-end gap-2"
						onSubmit={event => {
							event.preventDefault();
							const target = spec.trim();
							if (target) void install(target).then(ok => ok && setSpec(""));
						}}
					>
						<Input
							className="flex-1"
							label={t("plugins.installByName")}
							description={t("plugins.installByNameHint")}
							placeholder="github:owner/repo"
							boxClassName="font-mono"
							spellCheck={false}
							value={spec}
							onChange={event => setSpec(event.currentTarget.value)}
						/>
						<Button type="submit" variant="primary" icon={<Download />} disabled={!spec.trim() || Boolean(ops.runningFor(spec.trim()))}>
							{t("common.install")}
						</Button>
					</form>
					<section aria-label={t("plugins.availableTitle")} className="flex flex-col gap-3">
						<BracketLabel as="h3">{t("plugins.availableTitle")}</BracketLabel>
						{catalog.error ? (
							<Notice tone="warn">{t("plugins.offline")}</Notice>
						) : !catalog.data ? (
							<Skeleton height={56} />
						) : available.length === 0 ? (
							<EmptyState icon={<Package />} title={needle ? t("plugins.noMatch", { q: query.trim() }) : t("plugins.noMarketplaces")} body={needle ? undefined : t("plugins.noMarketplacesBody")} />
						) : (
							<ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-panel">
								{available.map(entry => (
									<AvailableRow key={entry.id} entry={entry} projectPath={projectPath} running={ops.runningFor(entry.id)} onInstall={scope => void install(entry.id, scope)} />
								))}
							</ul>
						)}
					</section>
				</>
			) : !listing.data && listing.loading ? (
				<div className="flex flex-col gap-2">
					{[0, 1, 2].map(i => (
						<Skeleton key={i} height={56} />
					))}
				</div>
			) : installed.length === 0 ? (
				<EmptyState
					icon={<Package />}
					title={needle ? t("plugins.noMatch", { q: query.trim() }) : t(filter === "project" ? "plugins.emptyProject" : "plugins.empty")}
					body={needle ? undefined : t("plugins.emptyBody")}
				/>
			) : (
				<ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-panel">
					{installed.map(plugin => {
						const newest = plugin.kind === "marketplace" ? latest.get(plugin.id) : undefined;
						const update = newest && compareVersions(newest, plugin.version) > 0 ? newest : null;
						return (
							<InstalledRow
								key={plugin.kind === "npm" ? plugin.name : `${plugin.id}#${plugin.scope}`}
								plugin={plugin}
								update={update}
								running={ops.runningFor(plugin.kind === "npm" ? plugin.name : plugin.id)}
								onToggle={enabled => void toggle(plugin, enabled)}
								onUpdate={() => plugin.kind === "marketplace" && void upgrade(plugin)}
								onRemove={() => void remove(plugin)}
							/>
						);
					})}
				</ul>
			)}

			<OperationLog ops={ops.list} onCancel={opId => void window.vomp.invoke("plugins:cancel", opId)} onDismiss={ops.dismiss} />
		</div>
	);
}

interface InstalledRowProps {
	plugin: Installed;
	update: string | null;
	running: Operation | undefined;
	onToggle(enabled: boolean): void;
	onUpdate(): void;
	onRemove(): void;
}

function InstalledRow({ plugin, update, running, onToggle, onUpdate, onRemove }: InstalledRowProps) {
	const { t } = useTranslation("extensions");
	const detail =
		plugin.kind === "npm"
			? (plugin.description ?? t("plugins.npmSource"))
			: plugin.shadowedByProject
				? t("plugins.shadowed")
				: t("plugins.fromMarketplace", { marketplace: plugin.marketplace });
	return (
		<li className="flex min-h-14 items-center gap-3 px-3 py-2">
			<LetterTile name={plugin.name} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-md font-semibold text-fg">{plugin.name}</span>
					<span className="shrink-0 font-mono text-xs text-fg-faint">v{plugin.version}</span>
					{plugin.kind === "marketplace" && (
						<Chip tone={plugin.scope === "project" ? "accent" : "neutral"}>{t(plugin.scope === "project" ? "scope.project" : "scope.user")}</Chip>
					)}
					{update && (
						<Chip tone="blue" icon={<CircleArrowUp />}>
							{t("plugins.updateChip", { from: plugin.version, to: update })}
						</Chip>
					)}
				</div>
				{running ? <InlineProgress op={running} /> : <p className="truncate text-sm text-fg-muted">{detail}</p>}
			</div>
			{update && (
				<Button size="sm" onClick={onUpdate} disabled={Boolean(running)}>
					{t("plugins.update")}
				</Button>
			)}
			<Switch checked={plugin.enabled} onCheckedChange={onToggle} disabled={Boolean(running)} aria-label={t(plugin.enabled ? "plugins.turnOff" : "plugins.turnOn", { name: plugin.name })} />
			<Button size="sm" variant="danger-ghost" icon={<Trash2 />} onClick={onRemove} disabled={Boolean(running)} aria-label={t("plugins.removeNamed", { name: plugin.name })}>
				{t("common.remove")}
			</Button>
		</li>
	);
}

function AvailableRow({
	entry,
	projectPath,
	running,
	onInstall,
}: {
	entry: AvailablePlugin;
	projectPath: string | null;
	running: Operation | undefined;
	onInstall(scope: PluginScope): void;
}) {
	const { t } = useTranslation("extensions");
	return (
		<li className="flex min-h-14 items-center gap-3 px-3 py-2">
			<LetterTile name={entry.name} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-md font-semibold text-fg">{entry.name}</span>
					{entry.version && <span className="shrink-0 font-mono text-xs text-fg-faint">v{entry.version}</span>}
					<span className="shrink-0 text-xs text-fg-faint">{t("plugins.fromMarketplace", { marketplace: entry.marketplace })}</span>
					{entry.installedScopes.map(scope => (
						<Chip key={scope} tone="ok">
							{t(scope === "project" ? "plugins.installedProject" : "plugins.installedUser")}
						</Chip>
					))}
				</div>
				{running ? <InlineProgress op={running} /> : entry.description && <p className="line-clamp-2 text-sm text-fg-muted">{entry.description}</p>}
			</div>
			<Menu>
				<MenuTrigger asChild>
					<Button size="sm" icon={<Download />} disabled={Boolean(running)} aria-label={t("plugins.installNamed", { name: entry.name })}>
						{t("common.install")}
					</Button>
				</MenuTrigger>
				<MenuContent align="end">
					<MenuItem disabled={entry.installedScopes.includes("user")} onSelect={() => onInstall("user")}>
						{t("skills.installFor.user")}
					</MenuItem>
					<MenuItem disabled={!projectPath || entry.installedScopes.includes("project")} onSelect={() => onInstall("project")}>
						{t("skills.installFor.project")}
					</MenuItem>
				</MenuContent>
			</Menu>
		</li>
	);
}
