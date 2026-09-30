import type { AppPreferences, ThemePreference } from "@shared/ipc";
import { Monitor, Moon, Sun } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/state/app";
import { Segmented, Slider } from "@/ui";
import { SettingRow, SettingsSection } from "./parts";

const THEMES: readonly { value: ThemePreference; icon: typeof Sun }[] = [
	{ value: "light", icon: Sun },
	{ value: "dark", icon: Moon },
	{ value: "system", icon: Monitor },
];
const MOTION: readonly AppPreferences["reducedMotion"][] = ["system", "on", "off"];

export function AppearanceTab() {
	const { t } = useTranslation("manage");
	const prefs = useApp(state => state.prefs);
	const setPrefs = useApp(state => state.setPrefs);
	// Local while dragging so the preview follows the thumb; saved on release.
	const [scale, setScale] = useState(prefs?.textScale ?? 100);
	useEffect(() => {
		if (prefs) setScale(prefs.textScale);
	}, [prefs]);
	if (!prefs) return null;

	return (
		<>
			<SettingsSection title={t("appearance.look")}>
				<SettingRow
					label={t("appearance.theme.label")}
					description={t("appearance.theme.description")}
					control={
						<Segmented
							aria-label={t("appearance.theme.label")}
							value={prefs.theme}
							onValueChange={theme => void setPrefs({ theme })}
							options={THEMES.map(({ value, icon: Icon }) => ({
								value,
								label: t(`appearance.theme.${value}`),
								icon: <Icon aria-hidden />,
							}))}
						/>
					}
				/>
				<div className="py-3">
					<div className="flex items-center justify-between gap-6">
						<div>
							<span className="text-md font-medium text-fg">{t("appearance.textSize.label")}</span>
							<p className="mt-0.5 text-sm text-fg-muted">{t("appearance.textSize.description")}</p>
						</div>
						<span className="font-mono text-sm text-fg-muted tabular-nums" aria-hidden>
							{scale}%
						</span>
					</div>
					<div className="mt-3 flex items-center gap-3">
						<span aria-hidden className="text-xs text-fg-faint">
							A
						</span>
						<Slider
							aria-label={t("appearance.textSize.label")}
							min={90}
							max={130}
							step={5}
							value={scale}
							formatValue={value => `${value}%`}
							onValueChange={setScale}
							onValueCommit={textScale => void setPrefs({ textScale })}
						/>
						<span aria-hidden className="text-lg text-fg-faint">
							A
						</span>
					</div>
					<p
						className="mt-3 rounded-lg border border-border bg-inset px-4 py-3 text-fg"
						// --text-md is 13px at 100%; px here so the root's current scale doesn't compound.
						style={{ fontSize: `${(13 * scale) / 100}px` }}
					>
						{t("appearance.textSize.preview")}
					</p>
				</div>
			</SettingsSection>

			<SettingsSection title={t("appearance.motion.title")}>
				<SettingRow
					label={t("appearance.motion.label")}
					description={t("appearance.motion.description")}
					control={
						<Segmented
							aria-label={t("appearance.motion.label")}
							value={prefs.reducedMotion}
							onValueChange={reducedMotion => void setPrefs({ reducedMotion })}
							options={MOTION.map(value => ({ value, label: t(`appearance.motion.${value}`) }))}
						/>
					}
				/>
			</SettingsSection>
		</>
	);
}
