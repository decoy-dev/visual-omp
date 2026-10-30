// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyCombinations, Table } from "./nodes/Table";
import { shortcutKeyLabel, shortcutKeyName, shortcutRuns } from "./shortcuts";

beforeEach(() => vi.stubGlobal("window", { vomp: { platform: "darwin" } }));
afterEach(() => vi.unstubAllGlobals());
describe("omp semantic shortcut cells", () => {
	it("keeps recorded alternatives separate and splits only their declared chords", () => {
		expect(shortcutRuns([{ t: "ctrl+a", s: "key" }, { t: " ", s: "dim" }, { t: "home", s: "key" }, { t: " ", s: "dim" }, { t: "super+left", s: "key" }])).toEqual([
			{ kind: "chord", source: "ctrl+a", keys: ["ctrl", "a"] }, { kind: "separator", text: "/" },
			{ kind: "chord", source: "home", keys: ["home"] }, { kind: "separator", text: "/" },
			{ kind: "chord", source: "super+left", keys: ["super", "left"] },
		]);
	});
	it("preserves omp's Hold, double-tap and empty-editor qualifiers and literal command syntax", () => {
		expect(shortcutRuns([{ t: "Hold ", s: "dim" }, { t: "space", s: "key" }])).toEqual([{ kind: "text", text: "Hold " }, { kind: "chord", source: "space", keys: ["space"] }]);
		expect(shortcutRuns([{ t: "ctrl+s", s: "key" }, { t: " / double-tap ", s: "dim" }, { t: "left", s: "key" }, { t: " (empty editor)", s: "dim" }])).toEqual([
			{ kind: "chord", source: "ctrl+s", keys: ["ctrl", "s"] }, { kind: "text", text: " / double-tap " }, { kind: "chord", source: "left", keys: ["left"] }, { kind: "text", text: " (empty editor)" },
		]);
		expect(shortcutRuns([{ t: "#<number>", s: "code" }])).toEqual([{ kind: "code", text: "#<number>" }]);
	});
	it("preserves a literal plus key only when omp marks it as a key", () => {
		expect(shortcutRuns([{ t: "ctrl++", s: "key" }, { t: " ", s: "dim" }, { t: "+", s: "key" }])).toEqual([{ kind: "chord", source: "ctrl++", keys: ["ctrl", "+"] }, { kind: "separator", text: "/" }, { kind: "chord", source: "+", keys: ["+"] }]);
		expect(shortcutRuns("up down left right")).toEqual([{ kind: "text", text: "up down left right" }]);
	});
	it("formats platform names without changing Control into Command", () => {
		expect(["ctrl", "super", "alt", "shift", "left", "up", "a"].map(key => shortcutKeyLabel(key, "darwin"))).toEqual(["⌃", "⌘", "⌥", "⇧", "←", "↑", "A"]);
		expect(["ctrl", "super", "alt", "shift", "home", "f5"].map(key => shortcutKeyLabel(key, "win32"))).toEqual(["Ctrl", "Win", "Alt", "Shift", "Home", "F5"]);
		expect(shortcutKeyLabel("unrecognized-key", "darwin")).toBe("unrecognized-key");
		expect(shortcutKeyLabel("super", "linux")).toBe("Super");
		expect(shortcutKeyName("super", "linux")).toBe("Super");
		expect(shortcutKeyName("super", "win32")).toBe("Windows");
		expect(shortcutKeyName("unrecognized-key", "darwin")).toBe("unrecognized-key");
	});
	it("exposes spoken chord names once and hides the visual glyphs from assistive technology", () => {
		const element = document.createElement("div");
		element.innerHTML = renderToStaticMarkup(createElement(KeyCombinations, { value: [{ t: "ctrl+a", s: "key" }, { t: " ", s: "dim" }, { t: "super+left", s: "key" }] }));
		expect([...element.querySelectorAll(".sr-only")].map(node => node.textContent)).toEqual(["Control + A", " or ", "Command + Left arrow"]);
		expect([...element.querySelectorAll("kbd")].every(node => node.closest('[aria-hidden="true"]'))).toBe(true);
		expect(element.querySelector("[aria-label]")).toBeNull();
	});
	it("preserves ordinary text in arbitrary columns named keys", () => {
		const element = document.createElement("div");
		element.innerHTML = renderToStaticMarkup(createElement(Table, { p: { cols: [{ id: "keys", head: "Key" }], rows: [{ id: "plain", cells: { keys: "api key" } }, { id: "spans", cells: { keys: [{ t: "api", s: "code" }, { t: " key" }] } }] } }));
		expect([...element.querySelectorAll("td")].map(node => node.textContent)).toEqual(["api key", "api key"]);
		expect(element.querySelector("kbd")).toBeNull();
	});
});
