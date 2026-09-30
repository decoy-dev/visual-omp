import type { ModelRolesState } from "@shared/contracts/config";
import { ArrowRight, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/state/app";
import { Button, Select, SelectItem } from "@/ui";
import { ModelSelect } from "../roles/ModelSelect";
import { useResource } from "../shared";
import { SettingRow, SettingsSection, SourceChip } from "./parts";
import type { OmpSettings } from "./useOmpSettings";

export function ModelsTab({ omp }: { omp: OmpSettings }) {
	const { t } = useTranslation("manage");
	const cwd = omp.cwd ?? undefined;
	const models = useResource(() => window.vomp.invoke("config:models", cwd), [cwd]);
	const roles = useResource(() => window.vomp.invoke("config:roles", cwd), [cwd]);
	const thinking = omp.byKey.get("defaultThinkingLevel");
	const defaultRole = roles.data?.roles.find(role => role.id === "default");

	const setDefaultModel = async (model: string | null) => {
		try {
			const next: ModelRolesState = await window.vomp.invoke(
				"config:roles:set",
				"default",
				model === null ? null : { model, thinking: defaultRole?.thinking ?? null },
				{ cwd, scope: omp.scope },
			);
			roles.setData(next);
		} catch (error) {
			omp.reportError(error);
		}
	};

	return (
		<>
			<SettingsSection title={t("modelsTab.group")} description={t("modelsTab.description")}>
				<SettingRow
					label={t("modelsTab.defaultModel.label")}
					description={t("modelsTab.defaultModel.description")}
					meta={defaultRole && <SourceChip source={defaultRole.source} />}
					control={
						defaultRole && (
							<ModelSelect
								className="w-64"
								aria-label={t("modelsTab.defaultModel.label")}
								models={models.data ?? []}
								accepts={defaultRole.acceptsKinds}
								value={defaultRole.model}
								onChange={value => void setDefaultModel(value)}
								autoLabel={t("roles.auto")}
								disabled={!models.data}
							/>
						)
					}
				/>
				{thinking?.enumValues && (
					<SettingRow
						label={t("modelsTab.thinking.label")}
						description={t("modelsTab.thinking.description")}
						meta={<SourceChip source={thinking.source} />}
						control={
							<Select
								className="w-64"
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
				)}
			</SettingsSection>
			{(models.error || roles.error) && (
				<p role="alert" className="mb-4 text-sm text-err">
					{models.error ?? roles.error}
				</p>
			)}
			<div className="flex items-center gap-4 rounded-lg border border-border bg-panel p-4">
				<span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-muted text-accent">
					<Layers aria-hidden className="size-4" />
				</span>
				<div className="min-w-0 flex-1">
					<p className="text-md font-medium text-fg">{t("modelsTab.roles.title")}</p>
					<p className="text-sm text-fg-muted">{t("modelsTab.roles.description")}</p>
				</div>
				<Button
					iconRight={<ArrowRight />}
					onClick={() => useApp.getState().openSheet("model-roles", { projectPath: omp.cwd })}
				>
					{t("modelsTab.roles.open")}
				</Button>
			</div>
		</>
	);
}
