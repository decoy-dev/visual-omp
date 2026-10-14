/** DESIGN §4.16: Skills & plugins, a Settings section with a tab for each. */
import { BookOpenText, Package } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsSectionProps } from "@/registry/slots";
import { PageHeader, PresenceSwap, SearchInput, Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui";
import { useLoad } from "../shared";
import type { BrowseFilter, SkillsSectionProps } from "./model";
import { PluginsTab } from "./PluginsTab";
import { SkillsTab } from "./SkillsTab";

export function SkillsSection({ projectPath, scope, props }: SettingsSectionProps) {
	const { t } = useTranslation("extensions");
	const link = (props ?? {}) as SkillsSectionProps;
	const home = useLoad(() => window.vomp.invoke("app:info"), []);
	// omp resolves skills/plugins for a working directory; without a project, the home folder shows user-level ones.
	const cwd = projectPath ?? home.data?.homeDir ?? null;
	const [tab, setTab] = useState<"skills" | "plugins">(link.tab ?? "skills");
	const [filter, setFilter] = useState<BrowseFilter>(() => {
		const wanted = link.filter ?? (scope === "project" ? "project" : "installed");
		return wanted === "project" && !projectPath ? "installed" : wanted;
	});
	const [query, setQuery] = useState("");
	const searchLabel = t(filter === "registry" ? `${tab}.searchRegistry` : `${tab}.search`);
	return (
		<>
			<PageHeader title={t("skills.title")} description={t("skills.subtitle")} />
			<Tabs value={tab} onValueChange={value => setTab(value === "plugins" ? "plugins" : "skills")} className="flex flex-col gap-4">
				<TabsList>
					<TabsTrigger value="skills" icon={<BookOpenText />}>
						{t("skills.tabs.skills")}
					</TabsTrigger>
					<TabsTrigger value="plugins" icon={<Package />}>
						{t("skills.tabs.plugins")}
					</TabsTrigger>
				</TabsList>
				<div className="flex flex-wrap items-center gap-3">
					<SearchInput value={query} onValueChange={setQuery} placeholder={searchLabel} aria-label={searchLabel} className="min-w-50 flex-1" />
					<Segmented<BrowseFilter>
						aria-label={t("skills.filterLabel")}
						value={filter}
						onValueChange={setFilter}
						options={[
							{ value: "installed", label: t("skills.filter.installed") },
							{ value: "project", label: t("skills.filter.project"), disabled: !projectPath },
							{ value: "registry", label: t(tab === "skills" ? "skills.filter.registry" : "plugins.filter.available") },
						]}
					/>
				</div>
				<PresenceSwap swapKey={tab}>
					<TabsContent forceMount value={tab}>
						{cwd &&
							(tab === "skills" ? (
								<SkillsTab cwd={cwd} projectPath={projectPath} filter={filter} query={query} onBrowse={() => setFilter("registry")} />
							) : (
								<PluginsTab cwd={cwd} projectPath={projectPath} filter={filter} query={query} onBrowse={() => setFilter("registry")} />
							))}
					</TabsContent>
				</PresenceSwap>
			</Tabs>
		</>
	);
}
