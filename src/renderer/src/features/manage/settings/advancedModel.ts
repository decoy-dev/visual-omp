/** Pure helpers behind the Advanced settings list: search, domain grouping and typed text input. */
import type { JsonValue, SettingInfo } from "@shared/contracts/config";

export type AdvancedRow =
	| { kind: "group"; domain: string; count: number }
	| { kind: "setting"; setting: SettingInfo };

/** Domain a setting is listed under: the first dotted segment, or `general` for top-level keys. */
export function settingDomain(setting: SettingInfo): string {
	return setting.namespace ? (setting.key.split(".")[0] ?? setting.key) : "general";
}

/**
 * Settings matching every word of `query` (key, description or current value), grouped by domain
 * (`general` first, then alphabetical), flattened into header + setting rows for the virtual list.
 */
export function buildAdvancedRows(settings: readonly SettingInfo[], query: string, editedOnly = false): AdvancedRow[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const groups = new Map<string, SettingInfo[]>();
	for (const setting of settings) {
		if (editedOnly && !setting.modified) continue;
		if (words.length > 0) {
			const haystack = `${setting.key} ${setting.description} ${setting.redacted ? "" : JSON.stringify(setting.value)}`.toLowerCase();
			if (!words.every(word => haystack.includes(word))) continue;
		}
		const domain = settingDomain(setting);
		const list = groups.get(domain);
		if (list) list.push(setting);
		else groups.set(domain, [setting]);
	}
	const domains = [...groups.keys()].sort((a, b) => (a === "general" ? -1 : b === "general" ? 1 : a.localeCompare(b)));
	const rows: AdvancedRow[] = [];
	for (const domain of domains) {
		const list = groups.get(domain) ?? [];
		rows.push({ kind: "group", domain, count: list.length });
		for (const setting of list) rows.push({ kind: "setting", setting });
	}
	return rows;
}

/** Text shown in a text-like control for a setting's value. */
export function valueToText(value: JsonValue): string {
	if (value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

export type ParsedInput = { ok: true; value: JsonValue } | { ok: false; error: "number" | "json" | "array" | "record" };

/** Parses what the user typed into the value `config:set` expects for the setting's type. */
export function parseSettingInput(type: SettingInfo["type"], text: string): ParsedInput {
	const trimmed = text.trim();
	switch (type) {
		case "number": {
			const value = Number(trimmed);
			return trimmed !== "" && Number.isFinite(value) ? { ok: true, value } : { ok: false, error: "number" };
		}
		case "boolean":
			return trimmed === "true" || trimmed === "false" ? { ok: true, value: trimmed === "true" } : { ok: false, error: "json" };
		case "array":
		case "record": {
			let value: unknown;
			try {
				value = JSON.parse(trimmed === "" ? (type === "array" ? "[]" : "{}") : trimmed);
			} catch {
				return { ok: false, error: "json" };
			}
			if (type === "array" && !Array.isArray(value)) return { ok: false, error: "array" };
			if (type === "record" && (value === null || typeof value !== "object" || Array.isArray(value))) {
				return { ok: false, error: "record" };
			}
			return { ok: true, value: value as JsonValue };
		}
		default:
			return { ok: true, value: text };
	}
}
