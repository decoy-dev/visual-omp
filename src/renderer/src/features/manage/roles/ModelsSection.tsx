/**
 * Settings → Models & roles (DESIGN §4.13): the default thinking level, which model omp uses for each
 * job (role), and presets. Role edits wait for an explicit Save; leaving with edits asks first.
 */
import type { ModelInfo, ModelPresetInfo, ModelRoleInfo, ModelRolesState, SettingScope } from "@shared/contracts/config";
import { ArrowsClockwise, ArrowUUpLeft, FloppyDisk, Warning } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsSectionProps } from "@/registry/slots";
import { useLeaveGuard, whenLeaving } from "@/state/leaveGuard";
import { Button, Chip, EmptyState, Expand, Notice, PageHeader, SectionHeader, Select, SelectItem, Skeleton, toast } from "@/ui";
import { ConfigNotices, SectionScope, SettingRow, SettingsSection, SourceChip } from "../settings/parts";
import { useOmpSettings } from "../settings/useOmpSettings";
import { ipcErrorMessage, useResource } from "../shared";
import { ModelCapabilities, ModelSelect } from "./ModelSelect";
import { PresetList, SavePresetDialog } from "./Presets";
import { changedRoleIds, findModel, modelValueStatus, orderRoles, type RoleDraft, thinkingChoices } from "./rolesModel";

export function ModelsSection({ projectPath, scope, setScope }: SettingsSectionProps) {
	const { t } = useTranslation("manage");
	const arg = projectPath ?? undefined;
	const omp = useOmpSettings(projectPath, scope);
	const roles = useResource(() => window.vomp.invoke("config:roles", arg), [arg]);
	const models = useResource(() => window.vomp.invoke("config:models", arg), [arg]);
	const presets = useResource(() => window.vomp.invoke("config:presets", arg), [arg]);

	const [drafts, setDrafts] = useState<Record<string, RoleDraft>>({});
	const [saving, setSaving] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [savePresetOpen, setSavePresetOpen] = useState(false);

	const ordered = useMemo(() => orderRoles(roles.data?.roles ?? []), [roles.data]);
	const changed = changedRoleIds(ordered, drafts);
	const dirty = changed.length > 0;
	useLeaveGuard(dirty, () => setDrafts({}));
	const draftFor = (role: ModelRoleInfo): RoleDraft => drafts[role.id] ?? { model: role.model, thinking: role.thinking };
	const thinking = omp.byKey.get("defaultThinkingLevel");

	/** Reads everything again and drops pending role edits; callers ask first (`ConfigNotices`, `whenLeaving`). */
	const reloadAll = () => {
		setDrafts({});
		void omp.snapshot.reload();
		void roles.reload();
		void models.reload();
		void presets.reload();
	};

	const refreshModels = async () => {
		setRefreshing(true);
		try {
			models.setData(await window.vomp.invoke("config:models:refresh", arg));
		} catch (error) {
			toast({ tone: "err", message: ipcErrorMessage(error) });
		} finally {
			setRefreshing(false);
		}
	};

	const save = async () => {
		setSaving(true);
		let latest: ModelRolesState | null = null;
		try {
			for (const id of changed) {
				const draft = drafts[id];
				if (!draft) continue;
				latest = await window.vomp.invoke(
					"config:roles:set",
					id,
					draft.model === null ? null : { model: draft.model, thinking: draft.thinking },
					{ cwd: arg, scope },
				);
			}
			if (latest) roles.setData(latest);
			setDrafts({});
			toast({ tone: "ok", message: t("roles.saved", { count: changed.length }) });
		} catch (error) {
			toast({ tone: "err", message: t("settings.saveFailed", { reason: ipcErrorMessage(error) }) });
			await roles.reload();
		} finally {
			setSaving(false);
		}
	};

	const applyPreset = async (preset: ModelPresetInfo) => {
		const before = roles.data;
		try {
			const result = await window.vomp.invoke("config:presets:apply", preset.name, arg);
			roles.setData(result.roles);
			setDrafts({});
			const shadowed = result.shadowed.length > 0 || result.shadowedThinking !== null;
			toast({
				tone: shadowed ? "warn" : "ok",
				message: t("roles.presetApplied", { name: preset.name }),
				description: shadowed ? t("roles.presetShadowed", { roles: result.shadowed.map(entry => entry.role).join(", ") }) : undefined,
				action: before ? { label: t("common.undo"), onClick: () => void whenLeaving(() => void undoPreset(before)) } : undefined,
			});
			// The preset also sets the default thinking level.
			void omp.snapshot.reload();
		} catch (error) {
			toast({ tone: "err", message: t("roles.presetFailed", { reason: ipcErrorMessage(error) }) });
		}
	};

	/** Restores every role (and the thinking default) to what it was before a preset was applied. */
	const undoPreset = async (before: ModelRolesState) => {
		try {
			const now = await window.vomp.invoke("config:roles", arg);
			let latest = now;
			for (const role of before.roles) {
				const after = now.roles.find(entry => entry.id === role.id);
				if (after?.value === role.value) continue;
				latest = await window.vomp.invoke(
					"config:roles:set",
					role.id,
					role.model === null ? null : { model: role.model, thinking: role.thinking },
					{ cwd: arg, scope: before.storage },
				);
			}
			if (before.defaultThinkingLevel !== latest.defaultThinkingLevel) {
				await window.vomp.invoke("config:set", "defaultThinkingLevel", before.defaultThinkingLevel, "global");
				latest = await window.vomp.invoke("config:roles", arg);
			}
			roles.setData(latest);
			setDrafts({});
			void omp.snapshot.reload();
		} catch (error) {
			toast({ tone: "err", message: t("settings.saveFailed", { reason: ipcErrorMessage(error) }) });
		}
	};

	const deletePreset = async (preset: ModelPresetInfo) => {
		try {
			const result = await window.vomp.invoke("config:presets:delete", preset.name, arg);
			if (result === "project") toast({ tone: "warn", message: t("roles.presetInProject", { name: preset.name }) });
			await presets.reload();
		} catch (error) {
			toast({ tone: "err", message: t("settings.saveFailed", { reason: ipcErrorMessage(error) }) });
		}
	};

	const loadError = roles.error ?? models.error;

	return (
		<>
			<PageHeader
				title={t("settings.sections.models")}
				description={t("modelsTab.description")}
				meta={<SectionScope projectPath={projectPath} scope={scope} setScope={setScope} />}
				actions={
					<Button icon={<ArrowsClockwise />} loading={refreshing} onClick={() => void refreshModels()}>
						{t("roles.refreshModels")}
					</Button>
				}
			/>
			<ConfigNotices cwd={projectPath} error={roles.data ? (loadError ?? omp.snapshot.error) : null} onReload={reloadAll} />

			{thinking?.enumValues && (
				<SettingsSection title={t("modelsTab.group")}>
					<SettingRow
						label={t("modelsTab.thinking.label")}
						description={t("modelsTab.thinking.description")}
						meta={<SourceChip source={thinking.source} />}
						control={
							<Select
								className="w-56"
								aria-label={t("modelsTab.thinking.label")}
								value={typeof thinking.value === "string" ? thinking.value : ""}
								onValueChange={value => void omp.write(thinking.key, value)}
							>
								{thinking.enumValues.map(value => (
									<SelectItem key={value} value={value}>
										{t(`thinking.${value}`)}
									</SelectItem>
								))}
							</Select>
						}
					/>
				</SettingsSection>
			)}

			<section aria-labelledby="manage-roles-title">
				<SectionHeader id="manage-roles-title" title={t("roles.title")} description={t("roles.description")} />
				{loadError && !roles.data ? (
					<EmptyState
						icon={<Warning />}
						title={t("roles.loadFailed")}
						body={loadError}
						actions={<Button onClick={() => void whenLeaving(reloadAll)}>{t("settings.retry")}</Button>}
					/>
				) : !roles.data ? (
					<div className="space-y-3" aria-busy>
						{Array.from({ length: 6 }, (_, index) => (
							<Skeleton key={index} height={96} />
						))}
					</div>
				) : (
					<>
						<ul className="divide-y divide-border border-y border-border">
							{ordered.map(role => (
								<RoleRow
									key={role.id}
									role={role}
									draft={draftFor(role)}
									unsaved={changed.includes(role.id)}
									models={models.data}
									scope={scope}
									onChange={draft => setDrafts(all => ({ ...all, [role.id]: draft }))}
								/>
							))}
						</ul>
						<footer className="sticky bottom-0 z-(--z-sticky) -mx-2 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg px-2 py-3">
							<p className="mr-auto text-sm text-fg-muted" aria-live="polite">
								{dirty ? t("roles.pending", { count: changed.length }) : t(`roles.saveTo.${scope}`)}
							</p>
							<Button variant="ghost" icon={<ArrowUUpLeft />} disabled={!dirty || saving} onClick={() => setDrafts({})}>
								{t("roles.revert")}
							</Button>
							<Button variant="primary" icon={<FloppyDisk />} disabled={!dirty} loading={saving} onClick={() => void save()}>
								{t("roles.save")}
							</Button>
						</footer>
					</>
				)}
			</section>

			<PresetList
				presets={presets.data}
				dirty={dirty}
				// Applying replaces every role, so pending edits are discarded first (after asking).
				onApply={preset => void whenLeaving(() => void applyPreset(preset))}
				onDelete={preset => void deletePreset(preset)}
				onSaveNew={() => setSavePresetOpen(true)}
			/>
			<SavePresetDialog
				open={savePresetOpen}
				onOpenChange={setSavePresetOpen}
				existing={presets.data ?? []}
				onSave={async name => {
					await window.vomp.invoke("config:presets:save", name, arg);
					await presets.reload();
					toast({ tone: "ok", message: t("roles.presetSaved", { name }) });
				}}
			/>
		</>
	);
}

const THINKING_DEFAULT = "__none__";

/**
 * One role: omp's name for it (`ModelRoleInfo.name`: the user's `modelTags` name or omp's built-in
 * name), the role id as secondary text, what the job is, and the model and thinking pickers.
 */
function RoleRow({
	role,
	draft,
	unsaved,
	models,
	scope,
	onChange,
}: {
	role: ModelRoleInfo;
	draft: RoleDraft;
	unsaved: boolean;
	models: ModelInfo[] | null;
	scope: SettingScope;
	onChange(draft: RoleDraft): void;
}) {
	const { t } = useTranslation("manage");
	const list = models ?? [];
	const status = modelValueStatus(draft.model, list);
	const model = findModel(draft.model, list);
	const choices = thinkingChoices(model, status === "available");
	const name = role.name || role.id;
	const titleId = `manage-role-${role.id}`;
	// Another layer decides this role: a project value while editing all projects.
	const overridden = scope === "global" && role.source === "project";
	const usage = role.builtIn
		? t(`roles.usage.${role.id}`, { defaultValue: t("roles.usage.custom", { id: role.id }) })
		: t("roles.usage.custom", { id: role.id });

	return (
		<li aria-labelledby={titleId} className="py-4">
			<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
				<h3 id={titleId} className="text-md font-semibold text-fg">
					{name}
				</h3>
				{name !== role.id && <span className="font-mono text-xs text-fg-faint">{role.id}</span>}
				{!role.builtIn && <Chip tone="accent">{t("roles.customChip")}</Chip>}
				{role.source === "project" && <Chip tone="neutral">{t("settings.source.project")}</Chip>}
				{unsaved && (
					<span className="inline-flex items-center gap-1.5 self-center text-xs text-accent">
						<span aria-hidden className="size-1.5 rounded-full bg-accent" />
						{t("roles.unsaved")}
					</span>
				)}
			</div>
			<p className="mt-0.5 text-sm text-fg-muted">{usage}</p>

			<div className="mt-3 flex flex-wrap gap-2">
				<ModelSelect
					className="min-w-0 flex-[2_1_16rem]"
					aria-label={t("roles.modelFor", { role: name })}
					models={list}
					accepts={role.acceptsKinds}
					value={draft.model}
					onChange={value => onChange({ model: value, thinking: value === null ? null : draft.thinking })}
					autoLabel={t("roles.auto")}
					disabled={!models}
				/>
				<Select
					className="min-w-0 flex-[1_1_10rem]"
					aria-label={t("roles.thinkingFor", { role: name })}
					value={draft.thinking !== null && choices.includes(draft.thinking) ? draft.thinking : THINKING_DEFAULT}
					onValueChange={value => onChange({ model: draft.model, thinking: choices.find(choice => choice === value) ?? null })}
					disabled={draft.model === null}
				>
					<SelectItem value={THINKING_DEFAULT}>{t("roles.thinkingDefault")}</SelectItem>
					{choices.map(choice => (
						<SelectItem key={choice} value={choice}>
							{t(`thinking.${choice}`)}
						</SelectItem>
					))}
				</Select>
			</div>
			{model && (
				<p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
					<span className="font-mono text-xs">{model.selector}</span>
					<ModelCapabilities model={model} />
				</p>
			)}

			<Expand open={status === "missing"} className="pt-3">
				<Notice tone="warn">{t("roles.missing")}</Notice>
			</Expand>
			<Expand open={status === "alias"} className="pt-2">
				<p className="text-sm text-fg-muted">{t("roles.aliasHelp", { alias: draft.model })}</p>
			</Expand>
			{overridden && (
				<Notice tone="info" className="mt-3">
					{t("roles.overridden", { value: role.projectValue })}
				</Notice>
			)}
		</li>
	);
}
