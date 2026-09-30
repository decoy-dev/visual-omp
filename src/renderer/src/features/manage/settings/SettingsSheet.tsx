/** Settings (DESIGN §4.12): app preferences plus omp's own settings, one sheet with a left nav. */
import type { SettingScope } from "@shared/contracts/config";
import * as RT from "@radix-ui/react-tabs";
import { ArrowsClockwise, Bell, type Icon, Info, Keyboard, Palette, Plug, ShieldCheck, SlidersHorizontal, Stack, Wrench } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "@/registry/slots";
import { Button, cn, Expand, PresenceSwap, Segmented } from "@/ui";
import { focusRingInset } from "@/ui/styles";
import { ModalSheet } from "../ModalSheet";
import { folderName, useExternalConfigChange, useResource, useSheetProject } from "../shared";
import { AboutTab } from "./AboutTab";
import { AdvancedTab } from "./AdvancedTab";
import { AlertsTab } from "./AlertsTab";
import { AppearanceTab } from "./AppearanceTab";
import { GeneralTab } from "./GeneralTab";
import { ModelsTab } from "./ModelsTab";
import { PermissionsTab } from "./PermissionsTab";
import { ProvidersTab } from "./ProvidersTab";
import { ShortcutsTab } from "./ShortcutsTab";
import { useOmpSettings } from "./useOmpSettings";

export const SETTINGS_TABS = [
	"general",
	"appearance",
	"permissions",
	"models",
	"providers",
	"alerts",
	"shortcuts",
	"about",
	"advanced",
] as const;
export type SettingsTabId = (typeof SETTINGS_TABS)[number];

export interface SettingsSheetProps {
	tab?: SettingsTabId;
	/** Project whose `.omp/config.yml` "This project" edits; defaults to the focused project. */
	projectPath?: string | null;
	/** Layer omp-setting edits go to first; defaults to all projects. */
	scope?: SettingScope;
}

const TAB_ICONS: Record<SettingsTabId, Icon> = {
	general: SlidersHorizontal,
	appearance: Palette,
	permissions: ShieldCheck,
	models: Stack,
	providers: Plug,
	alerts: Bell,
	shortcuts: Keyboard,
	about: Info,
	advanced: Wrench,
};

/** Tabs that write omp settings and therefore offer the scope choice. */
const SCOPED_TABS: ReadonlySet<SettingsTabId> = new Set(["general", "permissions", "models", "advanced"]);

export function SettingsSheet({ props, close }: SheetProps<SettingsSheetProps | undefined>) {
	const { t } = useTranslation("manage");
	const cwd = useSheetProject(props?.projectPath);
	const [tab, setTab] = useState<SettingsTabId>(props?.tab ?? "general");
	// Opening Settings again while it is open (e.g. "Add a provider…" from a model picker) switches tab.
	useEffect(() => {
		if (props?.tab) setTab(props.tab);
	}, [props]);
	const [scope, setScope] = useState<SettingScope>(props?.scope ?? "global");
	const omp = useOmpSettings(cwd, scope);
	const approval = useResource(() => window.vomp.invoke("config:approval", cwd ?? undefined), [cwd]);
	const [externalChange, clearExternalChange] = useExternalConfigChange(cwd);
	const indicatorId = useId();
	const loadError =
		omp.snapshot.error && tab !== "appearance" && tab !== "providers" && tab !== "alerts" && tab !== "shortcuts" && tab !== "about"
			? omp.snapshot.error
			: null;

	const reload = () => {
		clearExternalChange();
		void omp.snapshot.reload();
		void approval.reload();
	};

	return (
		<ModalSheet
			onClose={close}
			width={880}
			height={640}
			title={t("settings.title")}
			closeLabel={t("common.close")}
			actions={
				cwd &&
				SCOPED_TABS.has(tab) && (
					<div className="flex items-center gap-2">
						<span className="text-sm text-fg-muted">{t("settings.scope.label")}</span>
						<Segmented
							size="sm"
							aria-label={t("settings.scope.label")}
							value={scope}
							onValueChange={setScope}
							options={[
								{ value: "global", label: t("settings.scope.global") },
								{ value: "project", label: t("settings.scope.project", { name: folderName(cwd) }) },
							]}
						/>
					</div>
				)
			}
		>
			<RT.Root
				value={tab}
				onValueChange={value => setTab(SETTINGS_TABS.find(id => id === value) ?? "general")}
				orientation="vertical"
				className="flex min-h-0 flex-1"
			>
				<RT.List aria-label={t("settings.title")} className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-border bg-inset p-2">
					{SETTINGS_TABS.map(id => {
						const Icon = TAB_ICONS[id];
						return (
							<RT.Trigger
								key={id}
								value={id}
								className={cn(
									"relative flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-md text-fg-muted",
									"transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg",
									"data-[state=active]:font-medium data-[state=active]:text-fg data-[state=active]:hover:bg-transparent",
									focusRingInset,
								)}
							>
								{id === tab && (
									<motion.span layoutId={indicatorId} aria-hidden className="absolute inset-0 rounded-md bg-selected" />
								)}
								<Icon aria-hidden className="relative size-4 shrink-0" />
								<span className="relative">{t(`settings.tabs.${id}`)}</span>
							</RT.Trigger>
						);
					})}
				</RT.List>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<Expand open={externalChange}>
						<div role="status" className="flex items-center gap-3 border-b border-border bg-info-bg px-6 py-2 text-md text-fg">
							<span className="min-w-0 flex-1">{t("settings.externalChange")}</span>
							<Button size="sm" icon={<ArrowsClockwise />} onClick={reload}>
								{t("settings.reload")}
							</Button>
						</div>
					</Expand>
					<Expand open={loadError !== null}>
						<div role="alert" className="flex items-center gap-3 border-b border-border bg-err-bg px-6 py-2 text-md text-err">
							<span className="min-w-0 flex-1">{t("settings.loadFailed", { reason: loadError ?? "" })}</span>
							<Button size="sm" onClick={() => void omp.snapshot.reload()}>
								{t("settings.retry")}
							</Button>
						</div>
					</Expand>
					<PresenceSwap swapKey={tab} variant="rise" className="flex min-h-0 flex-1 flex-col">
						<RT.Content
							forceMount
							value={tab}
							// Radix makes the panel a tab stop; the inset ring shows where focus is when it lands here.
							className={cn("min-h-0 flex-1", focusRingInset, tab === "advanced" ? "flex flex-col" : "overflow-y-auto p-6")}
						>
							{tab !== "advanced" && <h2 className="mb-4 text-xl font-semibold text-fg">{t(`settings.tabs.${tab}`)}</h2>}
							{tab === "general" && <GeneralTab omp={omp} approval={approval} />}
							{tab === "appearance" && <AppearanceTab />}
							{tab === "permissions" && <PermissionsTab omp={omp} approval={approval} />}
							{tab === "models" && <ModelsTab omp={omp} />}
							{tab === "providers" && <ProvidersTab cwd={cwd} />}
							{tab === "alerts" && <AlertsTab />}
							{tab === "shortcuts" && <ShortcutsTab />}
							{tab === "about" && <AboutTab />}
							{tab === "advanced" && <AdvancedTab omp={omp} />}
						</RT.Content>
					</PresenceSwap>
				</div>
			</RT.Root>
		</ModalSheet>
	);
}
