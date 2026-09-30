import { BellRing } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/state/app";
import { Button, Switch } from "@/ui";
import { SettingsSection } from "./parts";

export function AlertsTab() {
	const { t } = useTranslation("manage");
	const prefs = useApp(state => state.prefs);
	const setPrefs = useApp(state => state.setPrefs);
	if (!prefs) return null;
	return (
		<SettingsSection title={t("alerts.title")} description={t("alerts.description")}>
			<Switch
				className="py-3"
				label={t("alerts.notifications.label")}
				description={t("alerts.notifications.description")}
				checked={prefs.notifications}
				onCheckedChange={notifications => void setPrefs({ notifications })}
			/>
			<div className="flex items-center justify-between gap-6 py-3">
				<p className="text-sm text-fg-muted">{t("alerts.test.description")}</p>
				<Button
					size="sm"
					icon={<BellRing />}
					disabled={!prefs.notifications}
					onClick={() => void window.vomp.invoke("app:notify", t("alerts.test.title"), t("alerts.test.body"))}
				>
					{t("alerts.test.button")}
				</Button>
			</div>
		</SettingsSection>
	);
}
