import { presetTheme } from "@shared/themes";
import { describe, expect, it } from "vitest";
import { copyTheme, isCustomTheme, parseHexInput, saveTheme, setThemeColor, uniqueThemeName } from "./colorThemes";

const forest = presetTheme("forest")!;

describe("custom themes", () => {
	it("copies a preset into an independent custom theme and edits one mode's color", () => {
		const mine = copyTheme(forest, "My Forest", forest.id);
		expect(isCustomTheme(mine)).toBe(true);
		expect(isCustomTheme(forest)).toBe(false);
		const edited = setThemeColor(mine, "dark", "accent", "#123456");
		expect(edited.dark.accent).toBe("#123456");
		expect(edited.light).toEqual(forest.light);
		expect(forest.dark.accent).not.toBe("#123456");
	});

	it("names copies uniquely without case, and saves in place or last", () => {
		const one = { ...copyTheme(forest, "My Forest", forest.id) };
		const two = { ...copyTheme(forest, "my forest 2", forest.id) };
		expect(uniqueThemeName("My Forest", [one, two])).toBe("My Forest 3");
		expect(uniqueThemeName("Night", [one])).toBe("Night");
		const renamed = { ...one, name: "Moss" };
		expect(saveTheme([one, two], renamed).map(theme => theme.name)).toEqual(["Moss", "my forest 2"]);
		expect(saveTheme([one], two).map(theme => theme.id)).toEqual([one.id, two.id]);
	});

	it("reads typed hex values with or without #, and three-digit shorthand", () => {
		expect([parseHexInput("#1E65AA"), parseHexInput(" 1e65aa "), parseHexInput("#abc"), parseHexInput("#12345"), parseHexInput("blue")]).toEqual(["#1e65aa", "#1e65aa", "#aabbcc", null, null]);
	});
});
