/** Model role presets: saved sets of role assignments that switch in one click. */
import type { ModelPresetInfo } from "@shared/contracts/config";
import { Plus, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Chip, cn, Dialog, DialogContent, IconButton, Input, SectionHeader } from "@/ui";
import { listRowMotion } from "../listMotion";
import { ipcErrorMessage } from "../shared";

const PRESET_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

function presetSummary(preset: ModelPresetInfo): string {
	const main = preset.modelRoles.default ?? Object.values(preset.modelRoles)[0] ?? "";
	return main.split(":")[0]?.split("/").pop() ?? main;
}

export function PresetList({
	presets,
	dirty,
	active,
	onApply,
	onDelete,
	onSaveNew,
}: {
	presets: ModelPresetInfo[] | null;
	/** Role edits are waiting: saving a preset would miss them. */
	dirty: boolean;
	active: string | null;
	onApply(preset: ModelPresetInfo): void;
	onDelete(preset: ModelPresetInfo): void;
	onSaveNew(): void;
}) {
	const { t } = useTranslation("manage");
	return (
		<section className="mt-10" aria-labelledby="manage-presets-title">
			<SectionHeader
				id="manage-presets-title"
				title={t("roles.presets.title")}
				description={t("roles.presets.description")}
				actions={
					<Button size="sm" icon={<Plus />} disabled={dirty} onClick={onSaveNew} title={dirty ? t("roles.presets.saveFirst") : undefined}>
						{t("roles.presets.saveNew")}
					</Button>
				}
			/>
			{presets && presets.length === 0 && <p className="text-sm text-fg-muted">{t("roles.presets.empty")}</p>}
			<ul className={cn("relative divide-y divide-border", presets && presets.length > 0 && "border-y border-border")}>
				<AnimatePresence initial={false} mode="popLayout">
					{presets?.map(preset => (
						<motion.li key={`${preset.source}:${preset.name}`} {...listRowMotion} className="flex items-center gap-3 bg-bg py-3">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="truncate text-md font-medium text-fg">{preset.name}</span>
									{preset.source === "project" && <Chip tone="neutral">{t("settings.source.project")}</Chip>}
									{active === preset.name && <Chip tone="accent">{t("roles.presets.active")}</Chip>}
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

export function SavePresetDialog({
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
