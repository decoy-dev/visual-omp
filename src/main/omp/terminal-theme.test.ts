import { describe, expect, it } from "vitest";
import { readTerminalTheme } from "./terminal-theme";

describe("omp terminal palettes", () => {
	it("uses compiled terminal fields in preference to the TUI's status-line background", () => {
		expect(readTerminalTheme({ modes: null, theme: { name: "titanium", background: "#0f1216", foreground: "#e5e5e7", terminal: { background: "#151820", foreground: "#e8ecf4" } } })).toEqual({ background: "#151820", foreground: "#e8ecf4", ansi: undefined });
	});
	it("uses active colours only for absent terminal fields", () => {
		expect(readTerminalTheme({ modes: null, theme: { name: "custom", background: "#000000", foreground: "#ffffff", terminal: { background: "#123456" } } })).toEqual({ background: "#123456", foreground: "#ffffff", ansi: undefined });
	});
	it("does not invent a terminal section for an in-memory or ambiguous theme", () => {
		expect(readTerminalTheme({ modes: null, theme: { name: null, background: "#123456", foreground: "#abcdef" } })).toEqual({ background: "#123456", foreground: "#abcdef", ansi: undefined });
	});
});
