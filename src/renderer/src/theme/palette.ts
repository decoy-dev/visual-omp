/**
 * Color themes (DESIGN §1.15): the five colors a theme sets for a mode, and the tokens.css palette derived from them.
 * Derivations follow the default palette's own steps (muted text 29% of the way from text to surface, faint 41%, and
 * so on), so a theme built from the default colors lands within a few hundredths of OKLCH lightness of tokens.css.
 * The default preset itself adds nothing and shows tokens.css as written.
 */
import { DEFAULT_COLOR_THEME, type ThemeColors, type ThemePalette } from "@shared/themes";

export type ThemeMode = "light" | "dark";

interface Oklch {
	l: number;
	c: number;
	h: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const toLinear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const toGamma = (channel: number) => (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055);

function hexToLinear(hex: string): [number, number, number] {
	const value = Number.parseInt(hex.slice(1), 16);
	return [toLinear(((value >> 16) & 255) / 255), toLinear(((value >> 8) & 255) / 255), toLinear((value & 255) / 255)];
}

/** `#rrggbb` to OKLCH (Björn Ottosson's OKLab matrices). */
export function hexToOklch(hex: string): Oklch {
	const [r, g, b] = hexToLinear(hex);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const c = Math.hypot(A, B);
	return { l: L, c, h: c < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinear({ l: L, c, h }: Oklch): [number, number, number] {
	const A = c * Math.cos((h * Math.PI) / 180);
	const B = c * Math.sin((h * Math.PI) / 180);
	const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
	const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
	const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
	return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const inGamut = (rgb: [number, number, number]) => rgb.every(channel => channel >= -1e-4 && channel <= 1 + 1e-4);

/** OKLCH to `#rrggbb`, lowering chroma at the same lightness and hue until the color fits sRGB. */
export function oklchToHex(color: Oklch): string {
	let fitted = { ...color, l: clamp(color.l, 0, 1) };
	if (!inGamut(oklchToLinear(fitted))) {
		let low = 0;
		let high = fitted.c;
		for (let step = 0; step < 24; step++) {
			const mid = (low + high) / 2;
			if (inGamut(oklchToLinear({ ...fitted, c: mid }))) low = mid;
			else high = mid;
		}
		fitted = { ...fitted, c: low };
	}
	return `#${oklchToLinear(fitted).map(channel => Math.round(clamp(toGamma(clamp(channel, 0, 1)), 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG 2 contrast ratio of two `#rrggbb` colors. */
export function contrastRatio(a: string, b: string): number {
	const luminance = (hex: string) => {
		const [r, g, bl] = hexToLinear(hex);
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (high + 0.05) / (low + 0.05);
}

const css = ({ l, c, h }: Oklch, alpha?: number) =>
	`oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)}${alpha === undefined ? "" : ` / ${alpha}`})`;
const lighten = (color: Oklch, by: number): Oklch => ({ ...color, l: clamp(color.l + by, 0, 1) });

/** `weight` of `a` mixed with `b` in OKLab, as an OKLCH value. */
function mix(a: Oklch, b: Oklch, weight: number): Oklch {
	const lab = ({ l, c, h }: Oklch) => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
	const [la, aa, ba] = lab(a);
	const [lb, ab, bb] = lab(b);
	const L = la! * weight + lb! * (1 - weight);
	const A = aa! * weight + ab! * (1 - weight);
	const B = ba! * weight + bb! * (1 - weight);
	const c = Math.hypot(A, B);
	return { l: L, c, h: c < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

const WHITE = "#ffffff";

/** Text on an accent fill, as `#rrggbb`: white where it reads 4.5:1, else a dark tint of the accent. */
function accentText(accent: Oklch): string {
	return contrastRatio(oklchToHex(accent), WHITE) >= 4.5 ? WHITE : oklchToHex({ l: 0.2, c: Math.min(accent.c, 0.03), h: accent.h });
}

/** Status colors for a light sidebar, from tokens.css's light theme (the chrome's own are tuned for ink). */
const LIGHT_CHROME_STATUS: Record<string, string> = {
	"--ok": "oklch(0.5 0.1 160)",
	"--ok-bg": "oklch(0.957 0.022 160)",
	"--warn": "oklch(0.53 0.11 65)",
	"--warn-bg": "oklch(0.962 0.028 78)",
	"--err": "oklch(0.52 0.16 25)",
	"--err-bg": "oklch(0.955 0.02 20)",
	"--err-hover": "oklch(0.47 0.15 25)",
	"--info": "oklch(0.52 0.12 255)",
	"--info-bg": "oklch(0.955 0.018 255)",
	"--diff-add-text": "oklch(0.47 0.1 160)",
	"--diff-del-text": "oklch(0.5 0.15 25)",
};

/** The sheet, canvas, card and text tokens for one mode. */
export function sheetTokens(colors: ThemeColors, mode: ThemeMode): Record<string, string> {
	const dark = mode === "dark";
	const accent = hexToOklch(colors.accent);
	const surface = hexToOklch(colors.surface);
	const canvas = hexToOklch(colors.canvas);
	const text = hexToOklch(colors.text);
	const ring = dark ? accent : lighten(accent, 0.06);
	return {
		"--chrome-bg": colors.sidebar,
		"--sheet": colors.surface,
		"--panel": dark ? css(lighten(surface, 0.025)) : colors.surface,
		"--bg-raised": dark ? css(lighten(surface, 0.045)) : colors.surface,
		"--bg-overlay": dark ? css(lighten(surface, 0.055)) : colors.surface,
		"--canvas": colors.canvas,
		"--bg-inset": css(lighten(canvas, dark ? -0.025 : -0.013)),
		"--hover": css(text, 0.05),
		"--selected": css(text, 0.09),
		"--fg": colors.text,
		"--fg-muted": css(mix(text, surface, 0.71)),
		"--fg-faint": css(mix(text, surface, 0.59)),
		"--fg-inverse": dark ? colors.canvas : colors.surface,
		"--accent": colors.accent,
		"--accent-hover": css(lighten(accent, dark ? 0.06 : -0.05)),
		"--accent-active": css(lighten(accent, dark ? 0.11 : -0.095)),
		"--accent-fg": accentText(accent),
		"--accent-muted": css({ l: clamp(surface.l + (dark ? 0.08 : -0.048), 0, 1), c: accent.c * (dark ? 0.4 : 0.27), h: accent.h }),
		"--accent-2": css(mix(text, surface, 0.77)),
		"--accent-2-muted": css(mix(text, surface, 0.07)),
		"--border": css(text, dark ? 0.12 : 0.14),
		"--border-strong": css(text, dark ? 0.2 : 0.22),
		"--control-border": css(mix(text, surface, 0.49)),
		"--ring": css(ring),
		"--ring-soft": css(ring, dark ? 0.24 : 0.18),
		"--work-glow": `0 0 0 3px ${css(accent, dark ? 0.16 : 0.14)}`,
		"--term-selection": css(accent, dark ? 0.24 : 0.2),
		"--syn-keyword": colors.accent,
		"--plot-dot": css(mix(text, surface, 0.75)),
	};
}

/** The sidebar's own text and accent: whichever ink reads better on it, and the accent moved toward that ink's side. */
function chromeColors(colors: ThemeColors): { sidebar: Oklch; text: Oklch; muted: Oklch; accent: Oklch; ink: boolean; theme: Oklch } {
	const sidebar = hexToOklch(colors.sidebar);
	const theme = hexToOklch(colors.accent);
	const light: Oklch = { l: 0.93, c: 0.005, h: sidebar.h };
	const dark: Oklch = { l: 0.22, c: 0.012, h: sidebar.h };
	// Light text unless dark text reads better: the default ink and every preset sidebar keep light text.
	const ink = contrastRatio(oklchToHex(light), colors.sidebar) >= contrastRatio(oklchToHex(dark), colors.sidebar);
	const text = ink ? light : dark;
	return { sidebar, text, muted: mix(text, sidebar, 0.75), accent: { ...theme, l: ink ? Math.max(theme.l, 0.78) : Math.min(theme.l, 0.5) }, ink, theme };
}

/**
 * The sidebar and status bar tokens (`[data-region="chrome"]`). With light text the accent sits at 0.78 lightness or
 * more, as on the default ink; with dark text it sits at 0.5 or less, and the light theme's status colors replace the
 * chrome's own.
 */
export function chromeTokens(colors: ThemeColors): Record<string, string> {
	const { sidebar, text, muted, accent, ink, theme } = chromeColors(colors);
	return {
		"color-scheme": ink ? "dark" : "light",
		"--bg": colors.sidebar,
		"--panel": colors.sidebar,
		"--bg-inset": css(text, 0.07),
		"--hover": css(text, 0.07),
		"--selected": css(text, 0.11),
		"--pill": css(text, 0.11),
		"--fg": css(text),
		"--fg-muted": css(muted),
		"--fg-faint": css(mix(text, sidebar, 0.6)),
		"--fg-inverse": ink ? css({ l: 0.18, c: 0.006, h: sidebar.h }) : WHITE,
		"--accent": css(accent),
		"--accent-hover": css(lighten(accent, ink ? 0.06 : -0.05)),
		"--accent-active": css(lighten(accent, ink ? 0.11 : -0.095)),
		"--accent-fg": accentText(accent),
		"--accent-muted": css({ l: clamp(sidebar.l + (ink ? 0.11 : -0.05), 0, 1), c: accent.c * 0.5, h: accent.h }),
		"--border": css(text, 0.1),
		"--border-strong": css(text, 0.16),
		"--control-border": css(mix(text, sidebar, 0.5)),
		"--ring": css(accent),
		"--ring-soft": css(accent, 0.24),
		"--page-card": css({ l: 0.65, c: Math.min(theme.c, 0.12), h: theme.h }),
		...(ink ? {} : LIGHT_CHROME_STATUS),
	};
}

const rule = (selector: string, tokens: Record<string, string>) =>
	`${selector} {\n${Object.entries(tokens).map(([name, value]) => `\t${name}: ${value};`).join("\n")}\n}`;

/**
 * The stylesheet that applies a theme, or "" for the default preset. `scope` prefixes the selectors: the app uses
 * `:root`, a preview its own attribute. The sheet rule (`:root[data-theme="light"]`) outranks tokens.css's
 * `[data-theme="light"]`. The chrome rule sits in `@scope (…) to ([data-theme])`, so it stops at any element that sets
 * its own theme (a preview, the setup wizard's miniature), and `:scope [data-region="chrome"]` outranks both of
 * tokens.css's chrome rules.
 */
export function colorThemeCss(id: string, palette: ThemePalette, scope = ":root"): string {
	if (id === DEFAULT_COLOR_THEME) return "";
	return (["light", "dark"] as const)
		.flatMap(mode => {
			const root = `${scope}[data-theme="${mode}"]`;
			return [rule(root, sheetTokens(palette[mode], mode)), `@scope (${root}) to ([data-theme]) {\n${rule(':scope [data-region="chrome"]', chromeTokens(palette[mode]))}\n}`];
		})
		.join("\n");
}

export interface ContrastIssue {
	/** What reads on what, as an i18n key under `appearance.colors.contrast`. */
	pair: "text" | "textCanvas" | "muted" | "accent" | "accentText" | "sidebarText" | "sidebarMuted" | "sidebarAccent";
	ratio: number;
}

/** The pairs this checks that fall below 4.5:1, on the surfaces and in the sidebar. */
export function contrastIssues(colors: ThemeColors): ContrastIssue[] {
	const chrome = chromeColors(colors);
	const checks: [ContrastIssue["pair"], string, string][] = [
		["text", colors.text, colors.surface],
		["textCanvas", colors.text, colors.canvas],
		["muted", oklchToHex(mix(hexToOklch(colors.text), hexToOklch(colors.surface), 0.71)), colors.surface],
		["accent", colors.accent, colors.surface],
		["accentText", accentText(hexToOklch(colors.accent)), colors.accent],
		["sidebarText", oklchToHex(chrome.text), colors.sidebar],
		["sidebarMuted", oklchToHex(chrome.muted), colors.sidebar],
		["sidebarAccent", oklchToHex(chrome.accent), colors.sidebar],
	];
	return checks.flatMap(([pair, a, b]) => {
		const ratio = contrastRatio(a, b);
		return ratio < 4.5 ? [{ pair, ratio }] : [];
	});
}

const STYLE_ID = "vomp-color-theme";

/**
 * Applies a color theme to the app: one `<style>` element after tokens.css, rewritten only when the CSS changes, and
 * `data-palette` on <html> so canvases and terminals that read tokens once know to read them again.
 */
export function applyColorTheme(id: string, palette: ThemePalette): void {
	const css = colorThemeCss(id, palette);
	let style = document.getElementById(STYLE_ID);
	if (!style) {
		style = document.createElement("style");
		style.id = STYLE_ID;
		document.head.append(style);
	}
	if (style.textContent !== css) style.textContent = css;
	// The CSS itself, not the id: editing a custom theme keeps its id and still changes the tokens.
	const revision = css ? `${id}:${css.length}:${hashText(css)}` : id;
	if (document.documentElement.dataset.palette !== revision) document.documentElement.dataset.palette = revision;
}

function hashText(text: string): string {
	let hash = 0;
	for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0;
	return (hash >>> 0).toString(36);
}
