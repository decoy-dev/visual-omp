import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { projectPath } from "../omp/project-path";

/** Development-only startup data. A tour must use its own fixture root and app profile. */
export function readReleaseTour(packaged: boolean, userData: string, env: NodeJS.ProcessEnv = process.env): unknown {
	if (packaged || !env.VOMP_TOUR_CHATS) return undefined;
	const file = env.VOMP_TOUR_CHATS;
	if (!isAbsolute(file) || !env.VOMP_DEV_PROFILE || !isAbsolute(env.VOMP_DEV_PROFILE)
		|| realpathSync(userData) !== realpathSync(env.VOMP_DEV_PROFILE)) throw new Error("Release tours require an absolute scratch profile and seed file.");
	const root = realpathSync(dirname(file));
	const inside = (path: unknown): path is string => {
		if (typeof path !== "string" || !isAbsolute(path)) return false;
		const child = relative(root, realpathSync(path));
		return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
	};
	if (!inside(file)) throw new Error("The release tour seed file must be inside its fixture root.");
	if (!inside(userData)) throw new Error("The release tour profile must be inside its fixture root.");
	const marker = JSON.parse(readFileSync(`${root}/fixture.json`, "utf8"));
	if (realpathSync(marker.root) !== root) throw new Error("The release tour fixture marker does not match its root.");
	const seed = JSON.parse(readFileSync(file, "utf8"));
	if (!seed || !Array.isArray(seed.tabs) || seed.tabs.length === 0 || seed.tabs.some((tab: { id?: unknown; title?: unknown; projectPath?: unknown; sessionFile?: unknown }) =>
		!tab || typeof tab.id !== "string" || !(typeof tab.title === "string" || tab.title === null) || !inside(tab.projectPath) || !inside(tab.sessionFile))) {
		throw new Error("Release tour chats must use fixture-local folders and session files.");
	}
	const tabs = (seed.tabs as { id: string; title: string | null; projectPath: string; sessionFile: string }[]).map(tab => ({
		id: tab.id, title: tab.title, projectPath: projectPath(tab.projectPath), sessionFile: realpathSync(tab.sessionFile),
	}));
	const active = tabs.find(tab => tab.id === seed.activeTabId) ?? tabs[0]!;
	const docks = Object.fromEntries(tabs.flatMap(tab => {
		const dock = seed.docks?.[tab.id];
		return dock && typeof dock.open === "boolean" && typeof dock.pane === "string" && typeof dock.width === "number" && Number.isFinite(dock.width)
			? [[tab.id, { open: dock.open, pane: dock.pane, width: dock.width }]] : [];
	}));
	// Project paths come only from the validated tabs. Do not forward arbitrary startup fields to hydration.
	return {
		tabs, activeTabId: active.id, activeProject: active.projectPath, expandedProjects: [],
		splitTabId: null, focusedSplit: "primary", sidebarOpen: true, unseenChats: {}, docks,
	};
}
