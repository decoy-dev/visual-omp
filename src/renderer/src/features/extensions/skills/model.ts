import { SKILL_PROVIDER_LABELS, type SkillEntry } from "@shared/contracts/skills";

/** Which skills or plugins the section lists: what's installed, this project's own, or what can be installed. */
export type BrowseFilter = "installed" | "project" | "registry";

/** Deep-link props for the Skills & plugins section (`openSettings("skills", { sectionProps })`). */
export interface SkillsSectionProps {
	tab?: "skills" | "plugins";
	filter?: BrowseFilter;
}

/** Display label of a skill source; unknown providers (newer omp) show their raw id. */
export function providerLabel(provider: string): string {
	return Object.entries(SKILL_PROVIDER_LABELS).find(([id]) => id === provider)?.[1] ?? provider;
}

/**
 * Why the toggle can't turn this skill back on here: anything but a plain per-skill disable
 * (whole-source toggles, glob filters, duplicates) lives in omp's settings. null = toggleable.
 */
export function lockedReason(skill: SkillEntry): SkillEntry["disabledReason"] {
	if (!skill.toggleName) return "duplicate";
	return skill.disabledReason && skill.disabledReason !== "disabled" ? skill.disabledReason : null;
}
