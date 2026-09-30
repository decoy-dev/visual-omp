/** DESIGN §4.16 — Skills & plugins browser. */
import { BookOpenText, Package } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetProps } from "@/registry/slots";
import { PresenceSwap, SearchInput, Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui";
import { type ExtensionSheetProps, ExtensionSheetFrame, useLoad, useSheetProject } from "../shared";
import { PluginsTab } from "./PluginsTab";
import { SkillsTab } from "./SkillsTab";

export type BrowseFilter = "installed" | "project" | "registry";

export interface SkillsSheetProps extends ExtensionSheetProps {
	tab?: "skills" | "plugins";
}

export function SkillsSheet({ props, close }: SheetProps<SkillsSheetProps>) {
	const { t } = useTranslation("extensions");
	const projectPath = useSheetProject(props);
	const home = useLoad(() => window.vomp.invoke("app:info"), []);
	// omp resolves skills/plugins for a working directory; without a project, the home folder shows user-level ones.
	const cwd = projectPath ?? home.data?.homeDir ?? null;
	const [tab, setTab] = useState<"skills" | "plugins">(props?.tab ?? "skills");
	const [filter, setFilter] = useState<BrowseFilter>(props?.scope === "project" && projectPath ? "project" : "installed");
	const [query, setQuery] = useState("");
	return (
		<ExtensionSheetFrame close={close} width={960} title={t("skills.title")} description={t("skills.subtitle")} bodyClassName="p-0">
			<Tabs value={tab} onValueChange={value => setTab(value === "plugins" ? "plugins" : "skills")} className="flex h-full flex-col">
				<div className="sticky top-0 z-(--z-sticky) flex flex-col gap-3 border-b border-border bg-overlay px-4 pt-2 pb-3">
					<TabsList>
						<TabsTrigger value="skills" icon={<BookOpenText />}>
							{t("skills.tabs.skills")}
						</TabsTrigger>
						<TabsTrigger value="plugins" icon={<Package />}>
							{t("skills.tabs.plugins")}
						</TabsTrigger>
					</TabsList>
					<div className="flex items-center gap-3">
						<SearchInput
							value={query}
							onValueChange={setQuery}
							placeholder={t(filter === "registry" ? `${tab}.searchRegistry` : `${tab}.search`)}
							aria-label={t(filter === "registry" ? `${tab}.searchRegistry` : `${tab}.search`)}
							className="flex-1"
						/>
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
				</div>
				<PresenceSwap swapKey={tab}>
					<TabsContent forceMount value={tab} className="p-4">
						{cwd &&
							(tab === "skills" ? (
								<SkillsTab cwd={cwd} projectPath={projectPath} filter={filter} query={query} />
							) : (
								<PluginsTab cwd={cwd} projectPath={projectPath} filter={filter} query={query} />
							))}
					</TabsContent>
				</PresenceSwap>
			</Tabs>
		</ExtensionSheetFrame>
	);
}
