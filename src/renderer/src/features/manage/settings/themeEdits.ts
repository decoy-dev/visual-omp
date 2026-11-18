import { errorText } from "@shared/errors";
import type { AppPreferences } from "@shared/ipc";
import { CUSTOM_THEMES_MAX, type CustomTheme } from "@shared/themes";
import { i18n } from "@/i18n";
import { useApp } from "@/state/app";
import { useThemePreview } from "@/theme/preview";
import { toast } from "@/ui";
import { copyTheme, saveTheme, uniqueThemeName } from "./colorThemes";

/**
 * Every change to color themes in Settings, run one at a time (DESIGN §1.15). Each change starts by saving a color
 * edit that is still waiting, then reads preferences as the change before it left them, so a slow save never makes a
 * later rename, delete or Undo work on an old list.
 */

/** How long a color edit waits before it is saved, so dragging through a color picker writes preferences once. */
export const SAVE_DELAY_MS = 300;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();
/** Themes deleted while an edit to them was still waiting; that edit is dropped instead of bringing them back. */
const deleted = new Set<string>();

/** A failed save, reported wherever the app is by then: a flush on leaving Settings or Undo from its toast can fail later. */
function report(error: unknown): void {
	toast({ tone: "err", message: i18n.t("settings:appearance.colors.saveFailed"), description: errorText(error) });
}

function serial<T>(change: () => Promise<T>): Promise<T> {
	const run = queue.then(change, change);
	queue = run.catch(() => undefined);
	return run;
}

/** Saves the waiting edit's colors into the stored theme (keeping a name changed since) and selects it. */
async function saveWaiting(): Promise<boolean> {
	clearTimeout(saveTimer);
	saveTimer = undefined;
	const theme = useThemePreview.getState().theme;
	const { prefs, setPrefs } = useApp.getState();
	if (!theme) return true;
	if (!prefs) return false;
	if (deleted.has(theme.id)) {
		useThemePreview.setState({ theme: null });
		return true;
	}
	const stored = prefs.customThemes.find(entry => entry.id === theme.id);
	const merged = stored ? { ...stored, light: theme.light, dark: theme.dark } : theme;
	try {
		await setPrefs({ customThemes: saveTheme(prefs.customThemes, merged), colorTheme: theme.id });
	} catch (error) {
		report(error);
		return false;
	}
	if (useThemePreview.getState().theme === theme) useThemePreview.setState({ theme: null });
	return true;
}

/** Shows an edited theme at once and saves it `SAVE_DELAY_MS` after the last change. */
export function queueEdit(theme: CustomTheme): void {
	useThemePreview.setState({ theme });
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => void flushEdit(), SAVE_DELAY_MS);
}

/** Saves a waiting edit now. False when the save failed; the edit then stays on screen. */
export function flushEdit(): Promise<boolean> {
	return serial(saveWaiting);
}

/** Saves a waiting edit, then applies `change` to current preferences (null changes nothing). False on any failure. */
function changeThemes(change: (prefs: AppPreferences) => Partial<AppPreferences> | null): Promise<boolean> {
	return serial(async () => {
		if (!(await saveWaiting())) return false;
		const prefs = useApp.getState().prefs;
		if (!prefs) return false;
		const patch = change(prefs);
		if (!patch) return true;
		try {
			await useApp.getState().setPrefs(patch);
			return true;
		} catch (error) {
			report(error);
			return false;
		}
	});
}

export function selectTheme(id: string): Promise<boolean> {
	return changeThemes(() => ({ colorTheme: id }));
}

/** Renames a custom theme, numbering the name when another theme has it. */
export function renameTheme(id: string, name: string): Promise<boolean> {
	return changeThemes(prefs => {
		const current = prefs.customThemes.find(entry => entry.id === id);
		if (!current) return null;
		const others = prefs.customThemes.filter(entry => entry.id !== id);
		return { customThemes: saveTheme(prefs.customThemes, { ...current, name: uniqueThemeName(name, others) }) };
	});
}

/** Copies a custom theme as `name` (numbered when taken) and selects the copy; nothing at the limit. */
export function duplicateTheme(id: string, name: string): Promise<boolean> {
	return changeThemes(prefs => {
		const source = prefs.customThemes.find(entry => entry.id === id);
		if (!source || prefs.customThemes.length >= CUSTOM_THEMES_MAX) return null;
		const copy = copyTheme(source, uniqueThemeName(name, prefs.customThemes), source.base);
		return { customThemes: [...prefs.customThemes, copy], colorTheme: copy.id };
	});
}

/**
 * Deletes a custom theme, returning to its preset when it was selected. Resolves to its Undo, which puts back this
 * theme alone, where it was, and selects it again only if the selection has not changed since; null when the delete
 * failed or the theme was already gone.
 */
export async function deleteTheme(id: string): Promise<(() => Promise<boolean>) | null> {
	let undo: (() => Promise<boolean>) | null = null;
	const ok = await changeThemes(prefs => {
		const index = prefs.customThemes.findIndex(entry => entry.id === id);
		if (index === -1) return null;
		const theme = prefs.customThemes[index]!;
		const fallback = prefs.colorTheme === id ? theme.base : null;
		deleted.add(id);
		undo = () => changeThemes(current => {
			if (current.customThemes.some(entry => entry.id === id) || current.customThemes.length >= CUSTOM_THEMES_MAX) return null;
			deleted.delete(id);
			const customThemes = [...current.customThemes];
			customThemes.splice(Math.min(index, customThemes.length), 0, theme);
			return { customThemes, ...(fallback && current.colorTheme === fallback ? { colorTheme: id } : {}) };
		});
		return { customThemes: prefs.customThemes.filter(entry => entry.id !== id), ...(fallback ? { colorTheme: fallback } : {}) };
	});
	if (!ok) deleted.delete(id);
	return ok ? undo : null;
}
