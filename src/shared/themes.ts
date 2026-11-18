/**
 * Color themes (DESIGN §1.15): a theme sets five colors for each of light and dark mode, and the renderer derives the
 * rest of the palette from them (`renderer/src/theme/palette.ts`). Presets ship with the app; custom themes are the
 * user's own, saved in app preferences. The default preset adds no overrides, so it shows tokens.css as written.
 */

/** The colors a theme sets, in the order the editor lists them. */
export const THEME_COLOR_KEYS = ["accent", "sidebar", "canvas", "surface", "text"] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
/** `#rrggbb` per color. */
export type ThemeColors = Record<ThemeColorKey, string>;

export interface ThemePalette {
	light: ThemeColors;
	dark: ThemeColors;
}

export interface PresetTheme extends ThemePalette {
	id: string;
}

export interface CustomTheme extends ThemePalette {
	id: string;
	name: string;
	/** The preset it started from, which Reset returns a color to. */
	base: string;
}

export const DEFAULT_COLOR_THEME = "visual-omp";
/** Custom theme names longer than this are cut. */
export const THEME_NAME_MAX = 40;
/** At most this many custom themes are kept. */
export const CUSTOM_THEMES_MAX = 50;

/**
 * Presets. The default repeats tokens.css (teal on near-neutral grays with a teal cast); the others keep its lightness
 * steps, which hold the contrast ratios in DESIGN §1.3, and move the accent and the neutral tint to another hue.
 */
export const PRESET_THEMES: readonly PresetTheme[] = [
	{
		id: DEFAULT_COLOR_THEME,
		light: { accent: "#10726f", sidebar: "#141919", canvas: "#f1f5f4", surface: "#feffff", text: "#141c1c" },
		dark: { accent: "#5fccc8", sidebar: "#080b0b", canvas: "#101414", surface: "#151919", text: "#e9eeee" },
	},
	{
		id: "ocean",
		light: { accent: "#1e65aa", sidebar: "#13191f", canvas: "#f0f4f9", surface: "#fefeff", text: "#121b25" },
		dark: { accent: "#88bcf6", sidebar: "#070a0e", canvas: "#0f1419", surface: "#13191f", text: "#e8edf3" },
	},
	{
		id: "forest",
		light: { accent: "#267543", sidebar: "#141a15", canvas: "#f1f5f1", surface: "#fefffe", text: "#141d16" },
		dark: { accent: "#75d291", sidebar: "#080b08", canvas: "#101511", surface: "#151a16", text: "#e9eeea" },
	},
	{
		id: "plum",
		light: { accent: "#7d45a2", sidebar: "#1a171d", canvas: "#f5f2f7", surface: "#fffeff", text: "#1e1822" },
		dark: { accent: "#cfa1f1", sidebar: "#0b090d", canvas: "#151217", surface: "#1a171d", text: "#efebf1" },
	},
	{
		id: "ember",
		light: { accent: "#ab4500", sidebar: "#1c1713", canvas: "#f7f3f0", surface: "#fffefe", text: "#211913" },
		dark: { accent: "#fea47c", sidebar: "#0c0907", canvas: "#161310", surface: "#1c1714", text: "#f0ece8" },
	},
	{
		id: "rose",
		light: { accent: "#af355c", sidebar: "#1d1618", canvas: "#f7f2f3", surface: "#fffefe", text: "#21171a" },
		dark: { accent: "#f69cb1", sidebar: "#0d090a", canvas: "#171213", surface: "#1c1618", text: "#f1ebec" },
	},
];

const HEX = /^#[0-9a-f]{6}$/;

export function isThemeColor(value: unknown): value is string {
	return typeof value === "string" && HEX.test(value);
}

function themeColors(value: unknown, fallback: ThemeColors): ThemeColors {
	const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const colors = { ...fallback };
	for (const key of THEME_COLOR_KEYS) {
		const color = typeof source[key] === "string" ? source[key].toLowerCase() : null;
		if (isThemeColor(color)) colors[key] = color;
	}
	return colors;
}

export function presetTheme(id: string): PresetTheme | undefined {
	return PRESET_THEMES.find(preset => preset.id === id);
}

/** Saved custom themes as preferences hold them: valid colors, a name, a known base, unique ids, at most `CUSTOM_THEMES_MAX`. */
export function normalizeCustomThemes(value: unknown): CustomTheme[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const themes: CustomTheme[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const raw = entry as Record<string, unknown>;
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		const name = typeof raw.name === "string" ? raw.name.trim().slice(0, THEME_NAME_MAX) : "";
		if (!id || !name || seen.has(id) || presetTheme(id)) continue;
		const base = presetTheme(typeof raw.base === "string" ? raw.base : "") ?? presetTheme(DEFAULT_COLOR_THEME)!;
		seen.add(id);
		themes.push({ id, name, base: base.id, light: themeColors(raw.light, base.light), dark: themeColors(raw.dark, base.dark) });
		if (themes.length === CUSTOM_THEMES_MAX) break;
	}
	return themes;
}

/** The theme `id` names, or the default preset when it names none. */
export function resolveColorTheme(id: string, custom: readonly CustomTheme[]): PresetTheme | CustomTheme {
	return presetTheme(id) ?? custom.find(theme => theme.id === id) ?? presetTheme(DEFAULT_COLOR_THEME)!;
}
