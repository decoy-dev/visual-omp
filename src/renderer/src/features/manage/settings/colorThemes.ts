import { type CustomTheme, presetTheme, type PresetTheme, THEME_NAME_MAX, type ThemeColorKey } from "@shared/themes";
import type { ThemeMode } from "@/theme/palette";

export function isCustomTheme(theme: PresetTheme | CustomTheme): theme is CustomTheme {
	return "name" in theme && !presetTheme(theme.id);
}

/** `name`, or `name 2`, `name 3`… when a custom theme already has it (compared without case). */
export function uniqueThemeName(name: string, themes: readonly CustomTheme[]): string {
	const base = name.trim().slice(0, THEME_NAME_MAX);
	const taken = new Set(themes.map(theme => theme.name.toLocaleLowerCase()));
	if (!taken.has(base.toLocaleLowerCase())) return base;
	for (let index = 2; ; index++) {
		const candidate = `${base.slice(0, THEME_NAME_MAX - String(index).length - 1)} ${index}`;
		if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
	}
}

/** A new custom theme with `source`'s colors. */
export function copyTheme(source: PresetTheme | CustomTheme, name: string, base: string): CustomTheme {
	return {
		id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
		name,
		base,
		light: { ...source.light },
		dark: { ...source.dark },
	};
}

export function setThemeColor(theme: CustomTheme, mode: ThemeMode, key: ThemeColorKey, value: string): CustomTheme {
	return { ...theme, [mode]: { ...theme[mode], [key]: value } };
}

/** `themes` with `theme` replacing the one with its id, or added last. */
export function saveTheme(themes: readonly CustomTheme[], theme: CustomTheme): CustomTheme[] {
	return themes.some(entry => entry.id === theme.id) ? themes.map(entry => (entry.id === theme.id ? theme : entry)) : [...themes, theme];
}

/** `#rrggbb` from what someone typed: an optional `#` and six hex digits, or three that expand. Null otherwise. */
export function parseHexInput(text: string): string | null {
	const digits = text.trim().replace(/^#/, "").toLowerCase();
	if (/^[0-9a-f]{6}$/.test(digits)) return `#${digits}`;
	if (/^[0-9a-f]{3}$/.test(digits)) return `#${[...digits].map(digit => digit + digit).join("")}`;
	return null;
}
