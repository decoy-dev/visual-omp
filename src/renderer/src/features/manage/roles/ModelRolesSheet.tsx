/** Model roles editor (DESIGN §4.13): which model omp uses for each kind of work, plus presets. */
import type {
	ModelInfo,
	ModelPresetInfo,
	ModelRoleInfo,
	ModelRolesState,
	SettingScope,
} from "@shared/contracts/config";
import * as RT from "@radix-ui/react-tabs";
import { ArrowsClockwise, ArrowUUpLeft, FloppyDisk, Plus, Warning, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "@/registry/slots";
import {
	Button,
	Chip,
	cn,
	Expand,
	Dialog,
	DialogContent,
	EmptyState,
	IconButton,
	Input,
	PresenceSwap,
	Segmented,
	Select,
	SelectItem,
	Skeleton,
	toast,
} from "@/ui";
import { focusRing, focusRingInset } from "@/ui/styles";
import { listRowMotion } from "../listMotion";
import { ModalSheet } from "../ModalSheet";
import { folderName, ipcErrorMessage, useExternalConfigChange, useResource, useSheetProject } from "../shared";
import { ModelCapabilities, ModelSelect } from "./ModelSelect";
import {
	changedRoleIds,
	findModel,
	modelValueStatus,
	orderRoles,
	type RoleDraft,
	thinkingChoices,
} from "./rolesModel";

export interface ModelRolesSheetProps {
	projectPath?: string | null;
	/** Layer to edit first; defaults to omp's `modelRoleStorage` (all projects unless set). */
	scope?: SettingScope;
	/** Role to select first. */
	role?: string;
}

const PRESET_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function ModelRolesSheet({ props, close }: SheetProps<ModelRolesSheetProps | undefined>) {
	const { t } = useTranslation("manage");
	const cwd = useSheetProject(props?.projectPath);
	const arg = cwd ?? undefined;
	const roles = useResource(() => window.vomp.invoke("config:roles", arg), [arg]);
	const models = useResource(() => window.vomp.invoke("config:models", arg), [arg]);
	const presets = useResource(() => window.vomp.invoke("config:presets", arg), [arg]);
	const [externalChange, clearExternalChange] = useExternalConfigChange(cwd);
	const indicatorId = useId();

	const [drafts, setDrafts] = useState<Record<string, RoleDraft>>({});
	const [selected, setSelected] = useState(props?.role ?? "default");
	const [scope, setScope] = useState<SettingScope | null>(props?.scope ?? null);
	const [saving, setSaving] = useState(false);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [savePresetOpen, setSavePresetOpen] = useState(false);

	const ordered = useMemo(() => orderRoles(roles.data?.roles ?? []), [roles.data]);
	const effectiveScope: SettingScope = cwd ? (scope ?? "global") : "global";
	const changed = changedRoleIds(ordered, drafts);
	const dirty = changed.length > 0;
	const draftFor = (role: ModelRoleInfo): RoleDraft => drafts[role.id] ?? { model: role.model, thinking: role.thinking };
	const current = ordered.find(role => role.id === selected) ?? ordered[0];

	useEffect(() => {
		if (!ordered.some(role => role.id === selected) && ordered[0]) setSelected(ordered[0].id);
	}, [ordered, selected]);

	const reloadAll = () => {
		clearExternalChange();
		setDrafts({});
		void roles.reload();
		void presets.reload();
	};

	const requestClose = () => (dirty ? setConfirmDiscard(true) : close());

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
					{ cwd: arg, scope: effectiveScope },
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
		const thinkingBefore = before?.defaultThinkingLevel;
		try {
			const result = await window.vomp.invoke("config:presets:apply", preset.name, arg);
			roles.setData(result.roles);
			setDrafts({});
			const shadowed = result.shadowed.length > 0 || result.shadowedThinking !== null;
			toast({
				tone: shadowed ? "warn" : "ok",
				message: t("roles.presetApplied", { name: preset.name }),
				description: shadowed ? t("roles.presetShadowed", { roles: result.shadowed.map(entry => entry.role).join(", ") }) : undefined,
				action: before
					? {
							label: t("common.undo"),
							onClick: () => void undoPreset(before, thinkingBefore ?? null),
						}
					: undefined,
			});
		} catch (error) {
			toast({ tone: "err", message: t("roles.presetFailed", { reason: ipcErrorMessage(error) }) });
		}
	};

	/** Restores every role (and the thinking default) to what it was before a preset was applied. */
	const undoPreset = async (before: ModelRolesState, thinking: string | null) => {
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
			if (thinking && thinking !== latest.defaultThinkingLevel) {
				await window.vomp.invoke("config:set", "defaultThinkingLevel", thinking, "global");
				latest = await window.vomp.invoke("config:roles", arg);
			}
			roles.setData(latest);
			setDrafts({});
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
		<ModalSheet
			onClose={requestClose}
			width={960}
			height={640}
			closeLabel={t("common.close")}
			title={
				<>
					{t("roles.title")}
					{dirty && (
						<span className="inline-flex items-center" title={t("roles.unsaved")}>
							<span aria-hidden className="size-2 rounded-full bg-accent" />
							<span className="sr-only">{t("roles.unsaved")}</span>
						</span>
					)}
				</>
			}
			description={t("roles.subtitle")}
			actions={
				<>
					{cwd && (
						<Segmented
							size="sm"
							aria-label={t("settings.scope.label")}
							value={effectiveScope}
							onValueChange={setScope}
							options={[
								{ value: "global", label: t("settings.scope.global") },
								{ value: "project", label: t("settings.scope.project", { name: folderName(cwd) }) },
							]}
						/>
					)}
					<IconButton
						label={t("roles.refreshModels")}
						icon={<ArrowsClockwise />}
						onClick={() =>
							void window.vomp
								.invoke("config:models:refresh", arg)
								.then(models.setData)
								.catch((error: unknown) => toast({ tone: "err", message: ipcErrorMessage(error) }))
						}
					/>
				</>
			}
		>
			{loadError && !roles.data ? (
				<div className="flex flex-1 items-center justify-center">
					<EmptyState
						icon={<Warning />}
						title={t("roles.loadFailed")}
						body={loadError}
						actions={<Button onClick={reloadAll}>{t("settings.retry")}</Button>}
					/>
				</div>
			) : (
				<RT.Root value={current?.id} onValueChange={setSelected} orientation="vertical" className="flex min-h-0 flex-1">
					<div className="flex w-[240px] shrink-0 flex-col border-r border-border bg-inset">
						<p className="px-4 pb-1 pt-3 text-sm font-medium text-fg-muted">{t("roles.listTitle")}</p>
						<RT.List aria-label={t("roles.listTitle")} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
							{!roles.data
								? Array.from({ length: 8 }, (_, index) => <Skeleton key={index} height={36} className="mb-1" />)
								: ordered.map(role => {
										const draft = draftFor(role);
										const model = findModel(draft.model, models.data ?? []);
										const status = modelValueStatus(draft.model, models.data ?? []);
										return (
											<RT.Trigger
												key={role.id}
												value={role.id}
												className={cn(
													"relative flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left",
													"transition-colors duration-(--dur-fast) hover:bg-hover data-[state=active]:hover:bg-transparent",
													focusRingInset,
												)}
											>
												{role.id === current?.id && (
													<motion.span layoutId={indicatorId} aria-hidden className="absolute inset-0 rounded-md bg-selected" />
												)}
												<span
													aria-hidden
													className={cn(
														"relative size-2 shrink-0 rounded-full",
														status === "missing" ? "bg-warn" : draft.model ? "bg-accent" : "border border-border-strong",
													)}
												/>
												<span className="relative min-w-0 flex-1">
													<span className="block truncate font-mono text-sm text-fg">{role.id}</span>
													<span className="block truncate text-xs text-fg-muted">
														{draft.model ? (model?.name ?? draft.model) : t("roles.auto")}
													</span>
												</span>
												{changed.includes(role.id) && (
													<span className="relative shrink-0" title={t("roles.unsaved")}>
														<span aria-hidden className="block size-1.5 rounded-full bg-accent" />
														<span className="sr-only">{t("roles.unsaved")}</span>
													</span>
												)}
											</RT.Trigger>
										);
									})}
						</RT.List>
					</div>
					<div className="flex min-h-0 min-w-0 flex-1 flex-col">
						<Expand open={externalChange}>
							<div role="status" className="flex items-center gap-3 border-b border-border bg-info-bg px-6 py-2 text-md text-fg">
								<span className="min-w-0 flex-1">{t("settings.externalChange")}</span>
								<Button size="sm" icon={<ArrowsClockwise />} onClick={reloadAll}>
									{t("settings.reload")}
								</Button>
							</div>
						</Expand>
						<div className="min-h-0 flex-1 overflow-y-auto p-6">
							{current && roles.data ? (
								<PresenceSwap swapKey={current.id} variant="rise">
									<RT.Content forceMount value={current.id} className={cn("rounded-md", focusRing)}>
										<RoleEditor
											role={current}
											draft={draftFor(current)}
											models={models.data}
											scope={effectiveScope}
											onChange={draft => setDrafts(all => ({ ...all, [current.id]: draft }))}
										/>
									</RT.Content>
								</PresenceSwap>
							) : (
								<Skeleton height={160} />
							)}
							<PresetsRow
								presets={presets.data}
								dirty={dirty}
								onApply={preset => void applyPreset(preset)}
								onDelete={preset => void deletePreset(preset)}
								onSaveNew={() => setSavePresetOpen(true)}
							/>
						</div>
						<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-3">
							<p className="mr-auto text-sm text-fg-muted" aria-live="polite">
								{dirty ? t("roles.pending", { count: changed.length }) : t(`roles.saveTo.${effectiveScope}`)}
							</p>
							<Button variant="ghost" icon={<ArrowUUpLeft />} disabled={!dirty || saving} onClick={() => setDrafts({})}>
								{t("roles.revert")}
							</Button>
							<Button variant="primary" icon={<FloppyDisk />} disabled={!dirty} loading={saving} onClick={() => void save()}>
								{t("roles.save")}
							</Button>
						</footer>
					</div>
				</RT.Root>
			)}

			<Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
				<DialogContent
					size="sm"
					title={t("roles.discard.title")}
					description={t("roles.discard.body", { count: changed.length })}
					footer={
						<>
							<Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
								{t("roles.discard.keep")}
							</Button>
							<Button variant="danger" onClick={close}>
								{t("roles.discard.confirm")}
							</Button>
						</>
					}
				/>
			</Dialog>
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
		</ModalSheet>
	);
}

const THINKING_DEFAULT = "__none__";

function RoleEditor({
	role,
	draft,
	models,
	scope,
	onChange,
}: {
	role: ModelRoleInfo;
	draft: RoleDraft;
	models: ModelInfo[] | null;
	scope: SettingScope;
	onChange(draft: RoleDraft): void;
}) {
	const { t } = useTranslation("manage");
	const list = models ?? [];
	const status = modelValueStatus(draft.model, list);
	const model = findModel(draft.model, list);
	const choices = thinkingChoices(model, status === "available");
	// Another layer decides this role: a project value while editing all projects.
	const overridden = scope === "global" && role.source === "project";

	return (
		<section aria-labelledby="manage-role-title">
			<div className="flex flex-wrap items-center gap-2">
				<h2 id="manage-role-title" className="text-xl font-semibold text-fg">
					{role.builtIn ? t(`roles.names.${role.id}`, { defaultValue: role.name }) : role.name}
				</h2>
				<Chip tone="neutral" className="font-mono">
					{role.id}
				</Chip>
				{!role.builtIn && <Chip tone="accent">{t("roles.customChip")}</Chip>}
				{role.source === "project" && <Chip tone="neutral">{t("settings.source.project")}</Chip>}
			</div>
			<p className="mt-1 text-md text-fg-muted">
				<span className="font-medium text-fg">{t("roles.usedFor")} </span>
				{role.builtIn ? t(`roles.usage.${role.id}`, { defaultValue: t("roles.usage.custom", { id: role.id }) }) : t("roles.usage.custom", { id: role.id })}
			</p>

			<div className="mt-5 grid grid-cols-[120px_1fr] items-center gap-x-4 gap-y-3">
				<span className="text-md text-fg-muted">{t("roles.model")}</span>
				<div className="flex min-w-0 items-center gap-2">
					<ModelSelect
						className="h-10 w-full max-w-[420px]"
						aria-label={t("roles.modelFor", { role: role.id })}
						models={list}
						accepts={role.acceptsKinds}
						value={draft.model}
						onChange={value => onChange({ model: value, thinking: value === null ? null : draft.thinking })}
						autoLabel={t("roles.auto")}
						disabled={!models}
					/>
					{draft.model !== null && (
						<IconButton label={t("roles.clear")} icon={<X />} onClick={() => onChange({ model: null, thinking: null })} />
					)}
				</div>
				{model && (
					<>
						<span />
						<span className="-mt-1 inline-flex items-center gap-2 text-sm text-fg-muted">
							<span className="font-mono text-xs">{model.selector}</span>
							<ModelCapabilities model={model} />
						</span>
					</>
				)}
				<span className="text-md text-fg-muted">{t("roles.thinking")}</span>
				<Select
					className="w-full max-w-[420px]"
					aria-label={t("roles.thinkingFor", { role: role.id })}
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

			<Expand open={draft.model === null} className="pt-3">
				<p className="text-sm text-fg-muted">{t("roles.autoHelp")}</p>
			</Expand>
			<Expand open={status === "missing"} className="pt-3">
				<p role="alert" className="flex items-center gap-2 rounded-md bg-warn-bg px-3 py-2 text-md text-warn">
					<Warning aria-hidden className="size-4 shrink-0" />
					{t("roles.missing")}
				</p>
			</Expand>
			<Expand open={status === "alias"} className="pt-3">
				<p className="text-sm text-fg-muted">{t("roles.aliasHelp", { alias: draft.model })}</p>
			</Expand>
			{overridden && (
				<p className="mt-3 flex items-center gap-2 rounded-md bg-info-bg px-3 py-2 text-md text-fg">
					{t("roles.overridden", { value: role.projectValue })}
				</p>
			)}
		</section>
	);
}

function presetSummary(preset: ModelPresetInfo): string {
	const main = preset.modelRoles.default ?? Object.values(preset.modelRoles)[0] ?? "";
	return main.split(":")[0]?.split("/").pop() ?? main;
}

function PresetsRow({
	presets,
	dirty,
	onApply,
	onDelete,
	onSaveNew,
}: {
	presets: ModelPresetInfo[] | null;
	dirty: boolean;
	onApply(preset: ModelPresetInfo): void;
	onDelete(preset: ModelPresetInfo): void;
	onSaveNew(): void;
}) {
	const { t } = useTranslation("manage");
	return (
		<section className="mt-8 border-t border-border pt-5" aria-labelledby="manage-presets-title">
			<div className="flex items-center justify-between gap-3">
				<div>
					<h3 id="manage-presets-title" className="text-md font-semibold text-fg">
						{t("roles.presets.title")}
					</h3>
					<p className="text-sm text-fg-muted">{t("roles.presets.description")}</p>
				</div>
				<Button size="sm" icon={<Plus />} disabled={dirty} onClick={onSaveNew} title={dirty ? t("roles.presets.saveFirst") : undefined}>
					{t("roles.presets.saveNew")}
				</Button>
			</div>
			{presets && presets.length === 0 && <p className="mt-3 text-sm text-fg-faint">{t("roles.presets.empty")}</p>}
			<ul className={cn("relative mt-3 divide-y divide-border", presets && presets.length > 0 && "border-y border-border")}>
				<AnimatePresence initial={false} mode="popLayout">
					{presets?.map(preset => (
						<motion.li key={`${preset.source}:${preset.name}`} {...listRowMotion} className="flex items-center gap-3 bg-overlay py-2.5">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="truncate text-md font-medium text-fg">{preset.name}</span>
									{preset.source === "project" && <Chip tone="neutral">{t("settings.source.project")}</Chip>}
								</div>
								<p className="truncate text-sm text-fg-muted">
									{t("roles.presets.summary", { model: presetSummary(preset), count: Object.keys(preset.modelRoles).length })}
								</p>
								{preset.problem && (
									<p className="truncate text-sm text-warn" title={preset.problem}>
										{preset.problem}
									</p>
								)}
							</div>
							<Button size="sm" disabled={Boolean(preset.problem)} onClick={() => onApply(preset)}>
								{t("roles.presets.apply")}
							</Button>
							{preset.source === "global" && (
								<IconButton size="sm" label={t("roles.presets.delete", { name: preset.name })} icon={<X />} onClick={() => onDelete(preset)} />
							)}
						</motion.li>
					))}
				</AnimatePresence>
			</ul>
		</section>
	);
}

function SavePresetDialog({
	open,
	onOpenChange,
	existing,
	onSave,
}: {
	open: boolean;
	onOpenChange(open: boolean): void;
	existing: readonly ModelPresetInfo[];
	onSave(name: string): Promise<void>;
}) {
	const { t } = useTranslation("manage");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const valid = PRESET_NAME.test(name);
	const overwrites = existing.some(preset => preset.source === "global" && preset.name === name);

	const submit = async () => {
		if (!valid) return;
		setBusy(true);
		try {
			await onSave(name);
			setName("");
			onOpenChange(false);
		} catch (err) {
			setError(ipcErrorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				size="sm"
				title={t("roles.presets.saveTitle")}
				description={t("roles.presets.saveBody")}
				footer={
					<>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							{t("common.cancel")}
						</Button>
						<Button variant="primary" disabled={!valid} loading={busy} onClick={() => void submit()}>
							{overwrites ? t("roles.presets.replace") : t("roles.presets.save")}
						</Button>
					</>
				}
			>
				<form
					onSubmit={event => {
						event.preventDefault();
						void submit();
					}}
				>
					<Input
						autoFocus
						label={t("roles.presets.name")}
						placeholder={t("roles.presets.namePlaceholder")}
						value={name}
						onChange={event => {
							setName(event.currentTarget.value);
							setError(null);
						}}
						error={error ?? (name && !valid ? t("roles.presets.nameInvalid") : overwrites ? t("roles.presets.nameTaken") : undefined)}
					/>
				</form>
			</DialogContent>
		</Dialog>
	);
}
