import type { AppPreferences } from "@shared/ipc";
import type { ApprovalMode } from "@shared/contracts/config";
import { useTranslation } from "react-i18next";
import type { SettingsSectionProps } from "@/registry/slots";
import { useApp } from "@/state/app";
import { PageHeader, Segmented, Select, SelectItem, Switch } from "@/ui";
import { useResource } from "../shared";
import { ConfigNotices, SectionScope, SettingRow, SettingsSection, SourceChip } from "./parts";
import { useOmpSettings } from "./useOmpSettings";

const APPROVAL_MODES: readonly ApprovalMode[] = ["always-ask", "write", "yolo"];
const TRANSCRIPT_MODES: readonly AppPreferences["transcriptMode"][] = ["normal", "thinking", "verbose"];

export function GeneralSection({ projectPath, scope, setScope }: SettingsSectionProps) {
	const { t } = useTranslation("manage");
	const omp = useOmpSettings(projectPath, scope);
	const approval = useResource(() => window.vomp.invoke("config:approval", projectPath ?? undefined), [projectPath]);
	const prefs = useApp(state => state.prefs);
	const setPrefs = useApp(state => state.setPrefs);
	const compaction = omp.byKey.get("compaction.enabled");
	const personality = omp.byKey.get("personality");
	const mode = approval.data?.mode;

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
			<SettingsSection title={t("general.safety")}>
				<SettingRow
					label={t("general.approvalMode.label")}
					description={t(`general.approvalMode.help.${mode ?? "none"}`)}
					meta={approval.data && <SourceChip source={approval.data.modeSource} />}
					control={
						mode && (
							<Segmented
								aria-label={t("general.approvalMode.label")}
								value={mode}
								onValueChange={value => void setMode(value)}
								options={APPROVAL_MODES.map(value => ({ value, label: t(`general.approvalMode.${value}`) }))}
							/>
						)
					}
				/>
			</SettingsSection>

			<SettingsSection title={t("general.chats")}>
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
						label={t("general.voice.label")}
						description={t("general.voice.description")}
						checked={prefs.voiceInput}
						onCheckedChange={voiceInput => void setPrefs({ voiceInput })}
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
