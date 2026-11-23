import type { AppPreferences } from "@shared/ipc";
import { compactAtValue, formatCompactAt } from "@shared/compaction";
import type { ApprovalMode } from "@shared/contracts/config";
import { useDeferredTranslation } from "@/i18n";
import { lazyView, LoadFailed } from "@/registry/lazy";
import type { SettingsSectionProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import { Button, PageHeader, Segmented, Select, SelectItem, Skeleton, Switch } from "@/ui";
import { useResource } from "../shared";
import { approvalModes } from "../../session-tools/approval";
import { ConfigNotices, OmpReading, SectionScope, SettingRow, SettingsSection, SourceChip } from "./parts";
import { useOmpSettings } from "./useOmpSettings";
import { AutoUpdateSwitch } from "./AutoUpdateSetting";
import { CompactAtField } from "../../compaction/CompactAtField";
import { pickNewChatFolder, saveNewChatFolder } from "../../projects/newChatFolder";
import { useState } from "react";

const TRANSCRIPT_MODES: readonly AppPreferences["transcriptMode"][] = ["normal", "thinking", "verbose"];
/** The width of the permission mode's four options, so the row keeps its layout while they load. */
const APPROVAL_PLACEHOLDER_WIDTH = 340;
const ProofsSetting = lazyView(() => import("../../live-preview/ProofsSetting").then(m => m.ProofsSetting), null, LoadFailed);

export function GeneralSection({ projectPath, scope, setScope }: SettingsSectionProps) {
	const { t } = useDeferredTranslation("settings");
	const omp = useOmpSettings(projectPath, scope);
	const approval = useResource(() => window.vomp.invoke("config:approval", projectPath ?? undefined), [projectPath]);
	const prefs = useApp(state => state.prefs);
	const setPrefs = useApp(state => state.setPrefs);
	const systemFolder = useApp(state => state.defaultChatFolder);
	const [folderBusy, setFolderBusy] = useState(false);
	const folderAction = (run: () => Promise<boolean>) => {
		if (folderBusy) return;
		setFolderBusy(true);
		void run().finally(() => setFolderBusy(false));
	};
	const compaction = omp.byKey.get("compaction.enabled");
	const compactAt = omp.byKey.get("compaction.thresholdTokens");
	// In project scope an empty field inherits the global point.
	const inheritedCompactAt = omp.scope === "project" ? compactAtValue(compactAt?.globalValue) : null;
	const personality = omp.byKey.get("personality");
	const mode = approval.data?.mode;
	const approvalPending = !approval.data && !approval.error;

	const setMode = async (next: ApprovalMode) => {
		try {
			approval.setData(await window.vomp.invoke("config:approval:setMode", next, omp.scope, omp.cwd ?? undefined));
		} catch (error) {
			omp.reportError(error);
		}
	};

	return (
		<>
			<PageHeader
				title={t("settings.sections.general")}
				description={t("general.description")}
				meta={<SectionScope projectPath={projectPath} scope={scope} setScope={setScope} />}
			/>
			<ConfigNotices
				cwd={projectPath}
				error={omp.snapshot.error}
				onReload={() => {
					void omp.snapshot.reload();
					void approval.reload();
				}}
			/>
			<OmpReading open={omp.pending || approvalPending} />
			<SettingsSection title={t("general.safety")} busy={approvalPending}>
				<SettingRow
					label={t("general.approvalMode.label")}
					description={t(`general.approvalMode.help.${approval.data && !mode ? "unknown" : mode ?? "none"}`, { value: JSON.stringify(approval.data?.rawMode) })}
					meta={approval.data && <SourceChip source={approval.data.modeSource} />}
					control={
						approval.data ? (
							<Segmented<ApprovalMode | "">
								aria-label={t("general.approvalMode.label")}
								value={mode ?? ""}
								onValueChange={value => { if (value) void setMode(value); }}
								options={approvalModes(approval.data).map(value => ({ value, label: t(`general.approvalMode.${value}`) }))}
							/>
						) : approvalPending && <Skeleton shape="control" width={APPROVAL_PLACEHOLDER_WIDTH} height={32} />
					}
				/>
			</SettingsSection>
			{(omp.pending || omp.byKey.has("update.auto")) && <SettingsSection title={t("general.updates")} busy={omp.pending}>
				<AutoUpdateSwitch omp={omp} />
			</SettingsSection>}

			<SettingsSection title={t("general.chats")} busy={omp.pending}>
				{prefs && (
					<SettingRow
						label={t("general.newChatFolder.label")}
						description={prefs.newChatFolder
							? t("general.newChatFolder.set", { path: prefs.newChatFolder })
							: t("general.newChatFolder.unset", { path: systemFolder ?? "" })}
						control={
							<div className="flex items-center gap-2">
								{prefs.newChatFolder && (
									<Button size="sm" variant="ghost" disabled={folderBusy} onClick={() => folderAction(() => saveNewChatFolder(null))}>{t("general.newChatFolder.reset")}</Button>
								)}
								<Button size="sm" variant="secondary" disabled={folderBusy} onClick={() => folderAction(pickNewChatFolder)}>
									{t("general.newChatFolder.choose")}
								</Button>
							</div>
						}
					/>
				)}
				{prefs && (
					<SettingRow
						label={t("general.transcript.label")}
						description={t("general.transcript.description")}
						control={
							<Segmented
								aria-label={t("general.transcript.label")}
								value={prefs.transcriptMode}
								onValueChange={value => void setPrefs({ transcriptMode: value })}
								options={TRANSCRIPT_MODES.map(value => ({ value, label: t(`general.transcript.${value}`) }))}
							/>
						}
					/>
				)}
				{prefs && (
					<Switch
						className="py-3"
						label={t("general.liveThinking.label")}
						description={t("general.liveThinking.description")}
						checked={prefs.liveThinking}
						onCheckedChange={liveThinking => void setPrefs({ liveThinking })}
					/>
				)}
				{prefs && (
					<>
						<Switch className="py-3" label={t("general.livePreview.label")} description={t("general.livePreview.description")}
							checked={prefs.livePreview} onCheckedChange={livePreview => void setPrefs({ livePreview })} />
						<Switch className="py-3" label={t("general.livePreviewOpenOutputs.label")} description={t("general.livePreviewOpenOutputs.description")}
							checked={prefs.livePreviewOpenOutputs} onCheckedChange={livePreviewOpenOutputs => void setPrefs({ livePreviewOpenOutputs })} />
						<ProofsSetting />
					</>
				)}
				{prefs && (
					<Switch
						className="py-3"
						label={t("general.voice.label")}
						description={t("general.voice.description")}
						checked={prefs.voiceInput}
						onCheckedChange={voiceInput => void setPrefs({ voiceInput })}
					/>
				)}
				{omp.pending && <Switch pending className="py-3" label={t("general.compaction.label")} description={t("general.compaction.description")} />}
				{omp.pending && <CompactAtPlaceholder label={t("general.compactAt.label")} />}
				{omp.pending && (
					<SettingRow
						label={t("general.personality.label")}
						description={t("general.personality.description")}
						control={<Skeleton shape="control" width={176} height={28} />}
					/>
				)}
				{compaction && (
					<Switch
						className="py-3"
						label={t("general.compaction.label")}
						description={t("general.compaction.description")}
						checked={compaction.value === true}
						onCheckedChange={checked => void omp.write(compaction.key, checked)}
					/>
				)}
				{compaction && compactAt && (
					<div className="py-3">
						<CompactAtField
							label={t("general.compactAt.label")}
							destination={`${omp.scope}\0${omp.cwd}`}
							description={t(compaction.value === true ? "general.compactAt.description" : "general.compactAt.off")}
							value={compactAtValue(omp.scope === "global" ? compactAt.globalValue : compactAt.projectValue)}
							placeholder={inheritedCompactAt !== null ? t("general.compactAt.inherited", { tokens: formatCompactAt(inheritedCompactAt) }) : t("compactAt.placeholder")}
							disabled={compaction.value !== true}
							onSave={tokens => tokens === null ? omp.reset(compactAt.key) : omp.write(compactAt.key, tokens)}
						/>
					</div>
				)}
				{personality?.enumValues && (
					<SettingRow
						label={t("general.personality.label")}
						description={t("general.personality.description")}
						meta={<SourceChip source={personality.source} />}
						control={
							<Select
								size="sm"
								className="w-44"
								aria-label={t("general.personality.label")}
								value={typeof personality.value === "string" ? personality.value : ""}
								onValueChange={value => void omp.write(personality.key, value)}
							>
								{personality.enumValues.map(value => (
									<SelectItem key={value} value={value}>
										{t(`general.personality.values.${value}`, { defaultValue: value })}
									</SelectItem>
								))}
							</Select>
						}
					/>
				)}
			</SettingsSection>
		</>
	);
}

/**
 * The compaction point's field while omp's settings load, laid out like `CompactAtField`: label, field and help text
 * in one column with Save at its foot. The help text depends on the value, so it is two placeholder lines.
 */
function CompactAtPlaceholder({ label }: { label: string }) {
	return (
		<div aria-busy className="flex items-end gap-2 py-3">
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<span className="text-md font-medium text-fg">{label}</span>
				<Skeleton shape="control" height={32} className="w-full" />
				<div className="flex flex-col gap-2 py-1">
					<Skeleton shape="text" />
					<Skeleton shape="text" width="70%" />
				</div>
			</div>
			<Skeleton shape="control" width={60} height={32} />
		</div>
	);
}
