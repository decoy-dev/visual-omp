import { describe, expect, it } from "vitest";
import { CUSTOM_THEMES_MAX, DEFAULT_COLOR_THEME, normalizeCustomThemes, presetTheme, resolveColorTheme } from "./themes";

const ocean = presetTheme("ocean")!;

describe("normalizeCustomThemes", () => {
	it("keeps valid themes, fills bad colors from the base preset and drops entries it cannot name", () => {
		const themes = normalizeCustomThemes([
			{ id: "a", name: "  Night shift  ", base: "ocean", light: { ...ocean.light, accent: "#FF0000" }, dark: { accent: "red", text: 12 } },
			{ id: "a", name: "Duplicate id", base: "ocean" },
			{ id: "ocean", name: "Shadows a preset", base: "ocean" },
			{ id: "b", name: "", base: "ocean" },
			{ id: "c", name: "No base", base: "missing" },
			"junk",
		]);
		expect(themes.map(theme => [theme.id, theme.name, theme.base])).toEqual([["a", "Night shift", "ocean"], ["c", "No base", DEFAULT_COLOR_THEME]]);
		expect(themes[0]!.light.accent).toBe("#ff0000");
		expect(themes[0]!.dark).toEqual(ocean.dark);
		expect(normalizeCustomThemes("nope")).toEqual([]);
	});

	it("keeps at most the first CUSTOM_THEMES_MAX themes", () => {
		const many = Array.from({ length: CUSTOM_THEMES_MAX + 5 }, (_, index) => ({ id: `t${index}`, name: `Theme ${index}`, base: "ocean" }));
		expect(normalizeCustomThemes(many).map(theme => theme.id)).toEqual(many.slice(0, CUSTOM_THEMES_MAX).map(theme => theme.id));
	});
});

it("resolves an unknown or deleted theme to the default preset", () => {
	const custom = normalizeCustomThemes([{ id: "mine", name: "Mine", base: "ocean" }]);
	expect(resolveColorTheme("mine", custom).id).toBe("mine");
	expect(resolveColorTheme("forest", custom).id).toBe("forest");
	expect(resolveColorTheme("gone", custom).id).toBe(DEFAULT_COLOR_THEME);
});
