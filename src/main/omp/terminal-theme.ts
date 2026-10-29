import type { NativeSnapshot, TerminalColors } from "@shared/contracts/native";

/** omp's public loader resolves variables and palette indices. Absent terminal fields use the active TUI colours. */
export function readTerminalTheme(snapshot: NativeSnapshot): TerminalColors | null {
	const active = snapshot.theme;
	if (!active) return null;
	return {
		background: active.terminal?.background || active.background,
		foreground: active.terminal?.foreground || active.foreground,
		ansi: active.terminal?.ansi,
	};
}
