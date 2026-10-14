import { BellRinging } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/state/app";
import { Button, PageHeader, Switch } from "@/ui";
import { SettingsSection } from "./parts";

export function AlertsSection() {
	const { t } = useTranslation("manage");
	const prefs = useApp(state => state.prefs);
	const setPrefs = useApp(state => state.setPrefs);
	const header = <PageHeader title={t("settings.sections.alerts")} description={t("alerts.description")} />;
	if (!prefs) return header;
	const platform = window.vomp.platform;
	return (
		<>
			{header}
			<SettingsSection>
				<Switch
					className="py-3"
					label={t("alerts.notifications.label")}
					description={t(`alerts.notifications.description.${platform}`)}
					checked={prefs.notifications}
					onCheckedChange={notifications => void setPrefs({ notifications })}
				/>
				{platform === "darwin" ? (
					// macOS denied banners to the tested ad-hoc signed build, so a test button would show nothing.
					<p className="py-3 text-sm text-fg-muted">{t("alerts.macNote")}</p>
				) : (
					<div className="flex items-center justify-between gap-6 py-3">
						<p className="text-sm text-fg-muted">{t("alerts.test.description")}</p>
						<Button
							size="sm"
							icon={<BellRinging />}
							disabled={!prefs.notifications}
							onClick={() => void window.vomp.invoke("app:notify", t("alerts.test.title"), t("alerts.test.body"))}
						>
							{t("alerts.test.button")}
						</Button>
					</div>
				)}
			</SettingsSection>
		</>
	);
}
