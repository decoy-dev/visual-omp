import type { JsonValue, ModelInfo, RoleThinking, SettingInfo, SettingScope, SettingSource } from "@shared/contracts/config";
import { findModel } from "./rolesModel";

export const FALLBACK_KEY = "retry.fallbackChains";
export type FallbackDraft = string[] | null;
export const fallbackRecord = (value: JsonValue | undefined): Record<string, JsonValue> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;

/** The editable record belongs to the selected layer, never to the merged effective snapshot. */
export function fallbackScopeRecord(setting: SettingInfo | undefined, scope: SettingScope): Record<string, JsonValue> | null {
	if (!setting) return null;
	const raw = scope === "project" ? setting.projectValue : setting.globalValue;
	return raw === null ? {} : fallbackRecord(raw);
}

/** A scoped control shows its own value, or the value it would inherit without higher layers. */
export function scopedFallbackSetting(setting: SettingInfo, scope: SettingScope): { value: JsonValue; source: SettingSource } {
	const own = scope === "project" ? setting.projectValue : setting.globalValue;
	if (own !== null) return { value: own, source: scope };
	if (scope === "project" && setting.globalValue !== null) return { value: setting.globalValue, source: "global" };
	return { value: setting.defaultValue, source: "default" };
}

/** Resolve only catalog entries we can edit without guessing at selector syntax. */
export function fallbackEntry(raw: JsonValue, models: readonly ModelInfo[]): { model: ModelInfo; thinking: RoleThinking | null } | null {
	if (typeof raw !== "string") return null;
	const literal = findModel(raw, models);
	if (literal) return { model: literal, thinking: null };
	const colon = raw.lastIndexOf(":");
	const suffix = raw.slice(colon + 1);
	const levels: readonly string[] = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
	if (colon < 0 || !levels.includes(suffix)) return null;
	const model = findModel(raw.slice(0, colon), models);
	return model ? { model, thinking: suffix as RoleThinking } : null;
}

/** A replacement keeps its position and removes exact duplicates, as in omp's model hub. */
export function replaceFallback(chain: readonly string[], index: number, value: string): string[] {
	return chain.map((entry, position) => position === index ? value : entry).filter((entry, position) => position === index || entry !== value);
}

export function changedFallbackRoles(drafts: Record<string, FallbackDraft>, record: Record<string, JsonValue> | null): string[] {
	return Object.keys(drafts).filter(role => {
		const draft = drafts[role];
		const current = record?.[role];
		if (draft === null) return !Array.isArray(current) || current.length !== 0;
		if (draft?.length === 0) return current !== undefined;
		return JSON.stringify(draft) !== JSON.stringify(current);
	});
}
