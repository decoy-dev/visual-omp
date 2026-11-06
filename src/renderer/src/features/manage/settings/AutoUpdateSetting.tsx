import { useDeferredTranslation } from "@/i18n";
import { Switch } from "@/ui";
import { useOmpSettings, type OmpSettings } from "./useOmpSettings";

export function AutoUpdateSwitch({ omp }: { omp: OmpSettings }) {
	const { t } = useDeferredTranslation("settings");
	const setting = omp.byKey.get("update.auto");
	if (!setting) return null;
	return <Switch className="py-3" label={t("general.autoUpdate.label")} description={t("general.autoUpdate.description")}
		checked={setting.value === true} onCheckedChange={value => void omp.write(setting.key, value)} />;
}

/** Setup uses the same capability and global config write as Settings. */
export function SetupAutoUpdateSetting() {
	const omp = useOmpSettings(null, "global");
	return <AutoUpdateSwitch omp={omp} />;
}
