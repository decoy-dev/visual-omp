/** Project folder colors (DESIGN §3.2): stored per project path in the app preferences, painted with `--folder-*`. */
import { PROJECT_COLORS, type ProjectColor } from "@shared/ipc";
import { useApp } from "./app";

export { PROJECT_COLORS, type ProjectColor };

/** CSS value for a project color (tokens.css `--folder-<color>`). */
export function projectColorValue(color: ProjectColor): string {
	return `var(--folder-${color})`;
}

/** The project's folder color, or null for the plain folder. Ignores values this version doesn't know. */
export function useProjectColor(path: string): ProjectColor | null {
	return useApp(state => {
		const color = state.prefs?.projectColors[path];
		return color && (PROJECT_COLORS as readonly string[]).includes(color) ? color : null;
	});
}

/** Give the project at `path` a folder color, or the plain folder with null. */
export async function setProjectColor(path: string, color: ProjectColor | null): Promise<void> {
	const { prefs, setPrefs } = useApp.getState();
	if (!prefs) return;
	const { [path]: _previous, ...others } = prefs.projectColors;
	await setPrefs({ projectColors: color ? { ...others, [path]: color } : others });
}
