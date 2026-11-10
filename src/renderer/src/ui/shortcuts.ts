import type { TspText } from "@shared/tsp";

export type ShortcutRun = { kind: "chord"; keys: string[]; source: string } | { kind: "text" | "code" | "separator"; text: string };

function chord(source: string): ShortcutRun {
	const keys = source === "+" ? ["+"] : source.endsWith("++") ? [...source.slice(0, -2).split("+"), "+"] : source.split("+");
	return { kind: "chord", keys, source };
}
/** omp marks each alternative with a separate `key` span. Non-key notes and command syntax stay literal. */
export function shortcutRuns(value: TspText): ShortcutRun[] {
	if (typeof value === "string") return [{ kind: "text", text: value }];
	return value.map((span, index) => {
		const styles = span.s?.split(" ") ?? [];
		if (styles.includes("key")) return chord(span.t);
		if (/^\s+$/.test(span.t) && value[index - 1]?.s?.split(" ").includes("key") && value[index + 1]?.s?.split(" ").includes("key")) return { kind: "separator", text: "/" };
		return { kind: styles.includes("code") ? "code" : "text", text: span.t };
	});
}

const KEY_LABELS: Readonly<Record<string, string>> = { super: "Super", cmd: "Super", meta: "Super", ctrl: "Ctrl", control: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift", up: "↑", down: "↓", left: "←", right: "→", enter: "Enter", return: "Enter", escape: "Esc", esc: "Esc", backspace: "Backspace", delete: "Del", tab: "Tab", space: "Space", home: "Home", end: "End", pageup: "Page Up", pagedown: "Page Down" };
const MAC_KEY_LABELS: Readonly<Record<string, string>> = { super: "⌘", cmd: "⌘", meta: "⌘", ctrl: "⌃", control: "⌃", alt: "⌥", option: "⌥", shift: "⇧", enter: "↵", return: "↵", backspace: "⌫", tab: "⇥", home: "↖", end: "↘" };

/** Preserve omp's actual modifier: its Control key is distinct from Super/Command. */
export function shortcutKeyLabel(key: string, platform: string): string {
	const name = key.toLowerCase();
	if (name === "super" || name === "cmd" || name === "meta") return platform === "darwin" ? "⌘" : platform === "win32" ? "Win" : "Super";
	return (platform === "darwin" ? MAC_KEY_LABELS[name] : undefined) ?? KEY_LABELS[name] ?? (/^[a-z]$|^f\d+$/i.test(key) ? key.toUpperCase() : key);
}

const SPOKEN_KEYS: Readonly<Record<string, string>> = { ctrl: "Control", control: "Control", shift: "Shift", up: "Up arrow", down: "Down arrow", left: "Left arrow", right: "Right arrow", enter: "Enter", return: "Enter", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", tab: "Tab", space: "Space", home: "Home", end: "End", pageup: "Page Up", pagedown: "Page Down", "+": "Plus" };
/** Spoken names stay independent of the visual platform glyphs. */
export function shortcutKeyName(key: string, platform: string): string {
	const name = key.toLowerCase();
	if (name === "super" || name === "cmd" || name === "meta") return platform === "darwin" ? "Command" : platform === "win32" ? "Windows" : "Super";
	if (name === "alt" || name === "option") return platform === "darwin" ? "Option" : "Alt";
	return SPOKEN_KEYS[name] ?? shortcutKeyLabel(key, platform);
}
