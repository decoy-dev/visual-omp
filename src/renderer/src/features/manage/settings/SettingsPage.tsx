/**
 * Settings (DESIGN §5.6): one page with a category rail. Features add sections to `settingsSections`;
 * each section renders its own `PageHeader`. Deep links (`openSettings`) choose the section, the
 * project and the scope; a new link while the page is open applies again (`seq`).
 */
import type { SettingScope } from "@shared/contracts/config";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type PageProps, type SettingsGroup, settingsSections } from "@/registry/slots";
import { whenLeaving } from "@/state/leaveGuard";
import { type SettingsPageProps, usePageBack } from "@/state/navigation";
import { NavRail, type NavRailGroup, type PageWidth, PageFrame } from "@/ui";

const GROUPS: readonly SettingsGroup[] = ["app", "agent", "context", "advanced"];

/** Sections that manage a list get the wider content column; the rest are forms. */
const LIST_SECTIONS: Partial<Record<string, true>> = { helpers: true, mcp: true, skills: true, memory: true };

interface PageState {
	section: string;
	projectPath: string | null;
	/** "project" only while there is a project to edit. */
	scope: SettingScope;
	sectionProps: unknown;
	/** `seq` of the deep link these values came from. */
	link: number;
}

function fromLink(props: Partial<SettingsPageProps> | undefined, link: number): PageState {
	const projectPath = props?.projectPath ?? null;
	return {
		section: props?.section ?? "general",
		projectPath,
		scope: projectPath && props?.scope === "project" ? "project" : "global",
		sectionProps: props?.sectionProps,
		link,
	};
}

export function SettingsPage({ props, seq, close }: PageProps<SettingsPageProps | undefined>) {
	const { t } = useTranslation("manage");
	const { t: tAny } = useTranslation();
	const back = usePageBack(close);
	const sections = settingsSections.use();
	const [state, setState] = useState(() => fromLink(props, seq));

	// A new deep link (`seq`) replaces everything; opening it already asked about unsaved edits.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `seq` changes with every link; `props` belongs to it.
	useEffect(() => setState(fromLink(props, seq)), [seq]);

	const current = sections.find(spec => spec.id === state.section) ?? sections[0];

	const groups = useMemo(
		(): NavRailGroup[] =>
			GROUPS.map(group => ({
				id: group,
				label: group === "advanced" ? undefined : t(`settings.groups.${group}`),
				items: sections
					.filter(spec => spec.group === group)
					.map(spec => ({ id: spec.id, label: tAny(spec.title), icon: <spec.icon aria-hidden /> })),
			})).filter(group => group.items.length > 0),
		[sections, t, tAny],
	);

	const setSection = (section: string) => {
		if (section === current?.id) return;
		void whenLeaving(() => setState(prev => ({ ...prev, section, sectionProps: undefined })));
	};
	const setScope = (scope: SettingScope) => {
		if (scope === state.scope) return;
		void whenLeaving(() => setState(prev => ({ ...prev, scope: prev.projectPath ? scope : "global" })));
	};

	const width: PageWidth = current && LIST_SECTIONS[current.id] ? "list" : "form";
	const Section = current?.component;
	// A new link or project starts the section fresh (its search, filter, open editor); a scope change keeps
	// it. Focus follows the same identity, so it moves only after the replacement section has mounted.
	// Links reach here through `openPage`, which asks about unsaved edits first.
	const sectionKey = `${current?.id ?? ""}:${state.link}:${state.projectPath ?? ""}`;

	return (
		<PageFrame
			back={back}
			label={t("settings.title")}
			width={width}
			focusKey={sectionKey}
			nav={<NavRail label={t("settings.railLabel")} groups={groups} value={current?.id ?? ""} onValueChange={setSection} />}
		>
			{Section && (
				<Section
					key={sectionKey}
					projectPath={state.projectPath}
					scope={state.scope}
					setScope={setScope}
					props={state.sectionProps}
				/>
			)}
		</PageFrame>
	);
}
