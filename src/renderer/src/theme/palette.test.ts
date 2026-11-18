import { DEFAULT_COLOR_THEME, PRESET_THEMES, presetTheme } from "@shared/themes";
import { describe, expect, it } from "vitest";
import { chromeTokens, colorThemeCss, contrastIssues, contrastRatio, hexToOklch, oklchToHex, sheetTokens } from "./palette";

const lightness = (value: string) => Number(/oklch\(([\d.]+)/.exec(value)?.[1]);

describe("color math", () => {
	it("round-trips sRGB through OKLCH and fits out-of-gamut colors by lowering chroma", () => {
		for (const hex of ["#000000", "#ffffff", "#10726f", "#ab4500", "#7d45a2"]) expect(oklchToHex(hexToOklch(hex))).toBe(hex);
		const vivid = oklchToHex({ l: 0.7, c: 0.4, h: 150 });
		expect(hexToOklch(vivid).l).toBeCloseTo(0.7, 2);
		expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
	});
});

describe("theme tokens", () => {
	it("adds nothing for the default preset, so tokens.css shows as written", () => {
		expect(colorThemeCss(DEFAULT_COLOR_THEME, presetTheme(DEFAULT_COLOR_THEME)!)).toBe("");
	});

	it("derives the default palette's steps from its own five colors", () => {
		const teal = presetTheme(DEFAULT_COLOR_THEME)!;
		// tokens.css: fg-muted 0.45, fg-faint 0.535, control-border 0.62 (light); 0.745, 0.645, 0.56 (dark).
		const light = sheetTokens(teal.light, "light");
		const dark = sheetTokens(teal.dark, "dark");
		expect([light["--fg-muted"], light["--fg-faint"], light["--control-border"]].map(lightness)).toEqual([expect.closeTo(0.45, 1), expect.closeTo(0.535, 1), expect.closeTo(0.62, 1)]);
		expect([dark["--fg-muted"], dark["--fg-faint"], dark["--control-border"]].map(lightness)).toEqual([expect.closeTo(0.745, 1), expect.closeTo(0.645, 1), expect.closeTo(0.56, 1)]);
		expect(light["--accent-fg"]).toBe("#ffffff");
		expect(contrastRatio(dark["--accent-fg"]!, teal.dark.accent)).toBeGreaterThanOrEqual(4.5);
	});

	it("keeps every preset readable in both modes, in the sidebar too", () => {
		for (const preset of PRESET_THEMES) {
			expect(contrastIssues(preset.light), `${preset.id} light`).toEqual([]);
			expect(contrastIssues(preset.dark), `${preset.id} dark`).toEqual([]);
		}
	});

	it("reports the pairs a custom color makes hard to read", () => {
		const pale = { ...presetTheme("ocean")!.light, text: "#9aa3ad", accent: "#ffd166" };
		expect(contrastIssues(pale).map(issue => issue.pair)).toEqual(["text", "textCanvas", "muted", "accent"]);
		// A mid-gray sidebar reads poorly with either ink; the check says so for its lighter text.
		expect(contrastIssues({ ...presetTheme("ocean")!.light, sidebar: "#777777" }).map(issue => issue.pair)).toContain("sidebarMuted");
	});

	it("gives a dark sidebar light text and a light sidebar dark text, an accent and status colors that read on it", () => {
		const ocean = presetTheme("ocean")!.light;
		const ink = chromeTokens(ocean);
		expect(lightness(ink["--fg"]!)).toBeGreaterThan(0.9);
		expect(lightness(ink["--accent"]!)).toBeGreaterThanOrEqual(0.78);
		expect(ink["--ok"]).toBeUndefined();
		const paper = chromeTokens({ ...ocean, sidebar: "#e8edf3" });
		// Text that reads better wins, whichever side of the middle the sidebar sits on.
		expect(lightness(chromeTokens({ ...ocean, sidebar: "#8a8f96" })["--fg"]!)).toBeLessThan(0.3);
		expect(lightness(paper["--fg"]!)).toBeLessThan(0.3);
		expect(lightness(paper["--accent"]!)).toBeLessThanOrEqual(0.5);
		expect(paper["color-scheme"]).toBe("light");
		expect(paper["--ok"]).toBe("oklch(0.5 0.1 160)");
	});

	it("scopes the stylesheet so it outranks tokens.css and stops at elements that set their own theme", () => {
		const css = colorThemeCss("plum", presetTheme("plum")!);
		expect(css).toContain(':root[data-theme="light"] {');
		expect(css).toContain('@scope (:root[data-theme="dark"]) to ([data-theme]) {\n:scope [data-region="chrome"] {');
		expect(css).toContain(`--accent: ${presetTheme("plum")!.light.accent};`);
		expect(colorThemeCss("plum", presetTheme("plum")!, '[data-theme-preview="p1"]')).toContain('@scope ([data-theme-preview="p1"][data-theme="dark"]) to ([data-theme]) {');
	});
});
