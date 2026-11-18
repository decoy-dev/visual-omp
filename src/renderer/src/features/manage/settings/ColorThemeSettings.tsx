import { ArrowCounterClockwise, DotsThree, Warning } from "@phosphor-icons/react";
import {
	CUSTOM_THEMES_MAX,
	type CustomTheme,
	PRESET_THEMES,
	presetTheme,
	type PresetTheme,
	resolveColorTheme,
	THEME_COLOR_KEYS,
	THEME_NAME_MAX,
	type ThemeColorKey,
	type ThemePalette,
} from "@shared/themes";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useDeferredTranslation } from "@/i18n";
import { useApp } from "@/state/app";
import { colorThemeCss, contrastIssues, type ThemeMode } from "@/theme/palette";
import { useThemePreview } from "@/theme/preview";
import { cn, IconButton, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Segmented, toast } from "@/ui";
import { copyTheme, isCustomTheme, parseHexInput, saveTheme, setThemeColor, uniqueThemeName } from "./colorThemes";
import { SettingsSection } from "./parts";
import { deleteTheme, duplicateTheme, flushEdit, queueEdit, renameTheme, selectTheme } from "./themeEdits";

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

/** The mode on screen, from the Theme preference and the system setting (App writes the same to `data-theme`). */
function useScreenMode(): ThemeMode {
	const theme = useApp(state => state.prefs?.theme ?? "light");
	const [dark, setDark] = useState(systemDark.matches);
	useEffect(() => {
		const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
		systemDark.addEventListener("change", onChange);
		return () => systemDark.removeEventListener("change", onChange);
	}, []);
	return theme === "system" ? (dark ? "dark" : "light") : theme;
}

/** Focus a theme's radio once the list has re-rendered (after renaming or deleting a row). */
function focusTheme(id: string): void {
	requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`input[data-theme-radio="${CSS.escape(id)}"]`)?.focus());
}

/**
 * Settings › Appearance › Colors (DESIGN §1.15): presets and the user's own themes as one radio list, then the five
 * colors of the active theme for light or dark mode. Changing a preset's color saves a copy named "My {preset}" and
 * switches to it; changes to a custom theme save to it.
 */
export function ColorThemeSettings(): ReactNode {
	const { t } = useDeferredTranslation("settings");
	const prefs = useApp(state => state.prefs);
	const preview = useThemePreview(state => state.theme);
	const screenMode = useScreenMode();
	const [mode, setMode] = useState<ThemeMode>(screenMode);
	// Edit the mode on screen; a theme switch moves the editor with it.
	useEffect(() => setMode(screenMode), [screenMode]);
	// Leaving Settings saves an edit that is still waiting.
	useEffect(() => () => void flushEdit(), []);
	if (!prefs) return null;

	const customs = preview ? saveTheme(prefs.customThemes, preview) : prefs.customThemes;
	const active = preview ?? resolveColorTheme(prefs.colorTheme, prefs.customThemes);
	const themeName = (theme: PresetTheme | CustomTheme) => (isCustomTheme(theme) ? theme.name : t(`appearance.colors.preset.${theme.id}`));
	const base = isCustomTheme(active) ? presetTheme(active.base) : active;
	const atLimit = prefs.customThemes.length >= CUSTOM_THEMES_MAX;
	// A preset's colors change only by saving a copy, which the limit rules out.
	const locked = !isCustomTheme(active) && atLimit;

	const edit = (key: ThemeColorKey, value: string) => {
		const current = useThemePreview.getState().theme ?? active;
		if (!isCustomTheme(current) && atLimit) return;
		const theme = isCustomTheme(current)
			? current
			: copyTheme(current, uniqueThemeName(t("appearance.colors.forkName", { name: themeName(current) }), prefs.customThemes), current.id);
		queueEdit(setThemeColor(theme, mode, key, value));
	};

	return (
		<SettingsSection title={t("appearance.colors.title")} description={t("appearance.colors.description")}>
			<div className="py-3">
				<ThemeList
					themes={[...PRESET_THEMES, ...customs]}
					activeId={active.id}
					mode={screenMode}
					name={themeName}
					atLimit={atLimit}
				/>
			</div>
			<div className="flex flex-col gap-3 py-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<span className="text-md font-medium text-fg">{t("appearance.colors.editing", { name: themeName(active) })}</span>
					<Segmented
						size="sm"
						aria-label={t("appearance.colors.mode.label")}
						value={mode}
						onValueChange={setMode}
						options={(["light", "dark"] as const).map(value => ({ value, label: t(`appearance.colors.mode.${value}`) }))}
					/>
				</div>
				<ThemePreview id={active.id} palette={active} mode={mode} />
				{locked && <p className="text-sm text-fg-muted">{t("appearance.colors.limit", { count: CUSTOM_THEMES_MAX })}</p>}
				<div className="divide-y divide-border">
					{THEME_COLOR_KEYS.map(key => (
						<ColorRow
							key={key}
							colorKey={key}
							value={active[mode][key]}
							baseValue={isCustomTheme(active) && base ? base[mode][key] : null}
							baseName={base ? themeName(base) : ""}
							disabled={locked}
							onChange={value => edit(key, value)}
						/>
					))}
				</div>
				<ContrastNotes colors={active[mode]} mode={mode} />
			</div>
		</SettingsSection>
	);
}

/** Presets, then custom themes, as one bordered radio list; each row shows the theme's colors for `mode`. */
function ThemeList({ themes, activeId, mode, name, atLimit }: {
	themes: readonly (PresetTheme | CustomTheme)[];
	activeId: string;
	mode: ThemeMode;
	name(theme: PresetTheme | CustomTheme): string;
	atLimit: boolean;
}): ReactNode {
	const { t } = useDeferredTranslation("settings");
	const group = useId();
	const [renaming, setRenaming] = useState<string | null>(null);
	return (
		<fieldset className="m-0 flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border p-0">
			<legend className="sr-only">{t("appearance.colors.themesLabel")}</legend>
			{themes.map(theme => {
				const checked = theme.id === activeId;
				const custom = isCustomTheme(theme);
				return (
					<div key={theme.id} className={cn("flex min-h-11 items-center gap-2 pr-2 transition-colors duration-(--dur-fast)", checked ? "bg-accent-muted" : "hover:bg-hover")}>
						{custom && renaming === theme.id ? (
							<RenameField
								theme={theme}
								onDone={restoreFocus => {
									setRenaming(null);
									if (restoreFocus) focusTheme(theme.id);
								}}
							/>
						) : (
							<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2 pl-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-ring">
								<input type="radio" name={group} data-theme-radio={theme.id} checked={checked} onChange={() => void selectTheme(theme.id)} className="size-4 shrink-0 accent-(--accent)" />
								<Swatches colors={theme[mode]} />
								<span className="min-w-0 truncate text-md text-fg">{name(theme)}</span>
								{theme.id === PRESET_THEMES[0]!.id && <span className="shrink-0 text-sm text-fg-muted">{t("appearance.colors.defaultHint")}</span>}
							</label>
						)}
						{custom && renaming !== theme.id && <CustomThemeMenu theme={theme} name={name(theme)} atLimit={atLimit} onRename={() => setRenaming(theme.id)} />}
					</div>
				);
			})}
		</fieldset>
	);
}

/** Sidebar, page background, surfaces and accent, as small dots with a hairline so pale colors stay visible. */
function Swatches({ colors }: { colors: CustomTheme["light"] }): ReactNode {
	return (
		<span aria-hidden className="flex shrink-0 items-center gap-1">
			{(["sidebar", "canvas", "surface", "accent"] as const).map(key => (
				<span key={key} className="size-3 rounded-full shadow-[inset_0_0_0_1px_var(--border-strong)]" style={{ background: colors[key] }} />
			))}
		</span>
	);
}

/** Inline rename. Enter saves and Escape cancels, each returning focus to the theme's radio; leaving the field saves and lets focus go where it went. */
function RenameField({ theme, onDone }: { theme: CustomTheme; onDone(restoreFocus: boolean): void }): ReactNode {
	const { t } = useDeferredTranslation("settings");
	const [name, setName] = useState(theme.name);
	// Enter or Escape unmounts the field, and the blur that may follow must not finish it again.
	const finished = useRef(false);
	const finish = (keep: boolean, restoreFocus: boolean) => {
		if (finished.current) return;
		finished.current = true;
		const trimmed = name.trim().slice(0, THEME_NAME_MAX);
		if (keep && trimmed && trimmed !== theme.name) void renameTheme(theme.id, trimmed);
		onDone(restoreFocus);
	};
	return (
		<Input
			autoFocus
			size="sm"
			aria-label={t("appearance.colors.renameLabel")}
			className="flex-1 py-1.5 pl-3"
			value={name}
			maxLength={THEME_NAME_MAX}
			onChange={event => setName(event.currentTarget.value)}
			onBlur={() => finish(true, false)}
			onKeyDown={event => {
				if (event.key === "Enter") finish(true, true);
				if (event.key === "Escape") {
					event.preventDefault();
					finish(false, true);
				}
			}}
		/>
	);
}

function CustomThemeMenu({ theme, name, atLimit, onRename }: { theme: CustomTheme; name: string; atLimit: boolean; onRename(): void }): ReactNode {
	const { t } = useDeferredTranslation("settings");
	// Rename and Delete take focus elsewhere, so the closing menu must not return it to this button.
	const moved = useRef(false);
	const remove = async () => {
		const undo = await deleteTheme(theme.id);
		if (!undo) {
			// The theme survived (a save failed, reported already): focus its row again.
			focusTheme(theme.id);
			return;
		}
		focusTheme(useApp.getState().prefs?.colorTheme ?? theme.base);
		toast({ message: t("appearance.colors.deleted", { name }), action: { label: t("appearance.colors.undo"), onClick: () => void undo() } });
	};
	return (
		<Menu>
			<MenuTrigger asChild>
				<IconButton size="sm" icon={<DotsThree />} label={t("appearance.colors.menu", { name })} />
			</MenuTrigger>
			<MenuContent
				align="end"
				onCloseAutoFocus={event => {
					if (!moved.current) return;
					moved.current = false;
					event.preventDefault();
				}}
			>
				<MenuItem onSelect={() => { moved.current = true; onRename(); }}>{t("appearance.colors.rename")}</MenuItem>
				<MenuItem disabled={atLimit} onSelect={() => void duplicateTheme(theme.id, t("appearance.colors.copyName", { name }))}>{t("appearance.colors.duplicate")}</MenuItem>
				<MenuSeparator />
				<MenuItem danger onSelect={() => { moved.current = true; void remove(); }}>{t("appearance.colors.delete")}</MenuItem>
			</MenuContent>
		</Menu>
	);
}

/** One color: its name and use, a color well, the hex value to type, and Reset when it differs from the preset. */
function ColorRow({ colorKey, value, baseValue, baseName, disabled, onChange }: {
	colorKey: ThemeColorKey;
	value: string;
	baseValue: string | null;
	baseName: string;
	disabled: boolean;
	onChange(value: string): void;
}): ReactNode {
	const { t } = useDeferredTranslation("settings");
	const label = t(`appearance.colors.key.${colorKey}.label`);
	const [text, setText] = useState(value);
	const [typing, setTyping] = useState(false);
	useEffect(() => {
		if (!typing) setText(value);
	}, [value, typing]);
	const typed = parseHexInput(text);
	return (
		<div className="flex items-center justify-between gap-6 py-3">
			<div className="min-w-0 flex-1">
				<span className="text-md font-medium text-fg">{label}</span>
				<p className="mt-1 text-sm text-fg-muted">{t(`appearance.colors.key.${colorKey}.description`)}</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{baseValue !== null && baseValue !== value && (
					<IconButton size="sm" icon={<ArrowCounterClockwise />} label={t("appearance.colors.reset", { color: label, theme: baseName })} disabled={disabled} onClick={() => onChange(baseValue)} />
				)}
				<input
					type="color"
					aria-label={t("appearance.colors.pickLabel", { color: label })}
					value={value}
					disabled={disabled}
					onChange={event => onChange(event.currentTarget.value)}
					className="size-8 cursor-pointer rounded-md border border-control-border bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-45 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
				/>
				<Input
					size="sm"
					aria-label={t("appearance.colors.hexLabel", { color: label })}
					className="w-24"
					boxClassName="font-mono"
					spellCheck={false}
					disabled={disabled}
					value={text}
					maxLength={7}
					aria-invalid={typed === null}
					onFocus={() => setTyping(true)}
					onBlur={() => {
						setTyping(false);
						setText(value);
					}}
					onChange={event => {
						setText(event.currentTarget.value);
						const parsed = parseHexInput(event.currentTarget.value);
						if (parsed && parsed !== value) onChange(parsed);
					}}
				/>
			</div>
		</div>
	);
}

/** A miniature of the app in the edited mode: sidebar with a selected row, page background, a card with text and a button. */
function ThemePreview({ id, palette, mode }: { id: string; palette: ThemePalette; mode: ThemeMode }): ReactNode {
	const scope = `p${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	const css = colorThemeCss(id, palette, `[data-theme-preview="${scope}"]`);
	return (
		<>
			{css && <style>{css}</style>}
			<div aria-hidden data-theme-preview={scope} data-theme={mode} className="flex h-32 overflow-hidden rounded-lg border border-border text-fg">
				<div data-region="chrome" className="flex w-32 shrink-0 flex-col gap-1.5 bg-bg p-2.5">
					<span className="h-2 w-14 rounded-full bg-accent" />
					<span className="mt-1.5 flex h-5 items-center rounded-sm bg-pill px-1.5"><span className="h-1.5 w-16 rounded-full bg-fg" /></span>
					<span className="flex h-5 items-center px-1.5"><span className="h-1.5 w-12 rounded-full bg-fg-muted" /></span>
					<span className="flex h-5 items-center px-1.5"><span className="h-1.5 w-14 rounded-full bg-fg-faint" /></span>
				</div>
				<div className="flex flex-1 items-start bg-canvas p-3">
					<div className="flex w-full max-w-64 flex-col gap-2 rounded-md border border-border bg-panel p-3">
						<span className="h-2 w-28 rounded-full bg-fg" />
						<span className="h-1.5 w-40 rounded-full bg-fg-muted" />
						<span className="h-1.5 w-32 rounded-full bg-fg-faint" />
						<span className="mt-1 flex h-6 w-16 items-center justify-center self-end rounded-sm bg-accent"><span className="h-1.5 w-8 rounded-full bg-accent-fg" /></span>
					</div>
				</div>
			</div>
		</>
	);
}

/** The checked pairs below 4.5:1 in the edited mode, worded as what reads on what. */
function ContrastNotes({ colors, mode }: { colors: CustomTheme["light"]; mode: ThemeMode }): ReactNode {
	const { t } = useDeferredTranslation("settings");
	const issues = contrastIssues(colors);
	if (issues.length === 0) return null;
	return (
		<div role="status" className="flex gap-2 rounded-lg border border-border bg-warn-bg px-3 py-2.5 text-sm text-fg">
			<Warning aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
			<div>
				<p>{t("appearance.colors.contrast.title", { mode: t(`appearance.colors.mode.${mode}`) })}</p>
				<ul className="mt-1 list-disc pl-4 text-fg-muted">
					{issues.map(issue => (
						<li key={issue.pair}>{t(`appearance.colors.contrast.${issue.pair}`, { ratio: issue.ratio.toFixed(1) })}</li>
					))}
				</ul>
			</div>
		</div>
	);
}
