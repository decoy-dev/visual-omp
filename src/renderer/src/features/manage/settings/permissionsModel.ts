import type { SettingInfo, SettingScope } from "@shared/contracts/config";

/** Project edits retain inherited restrictions; global edits never promote a project's list. */
export function restrictedFoldersForEdit(setting: Pick<SettingInfo, "globalValue" | "projectValue"> | undefined, scope: SettingScope): string[] {
	const raw = scope === "project" ? setting?.projectValue ?? setting?.globalValue : setting?.globalValue;
	return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}
