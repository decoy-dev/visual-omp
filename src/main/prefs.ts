import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { AppPreferences } from "@shared/ipc";
import { broadcast } from "./ipc";

const DEFAULTS: AppPreferences = {
	theme: "light",
	textScale: 100,
	reducedMotion: "system",
	transcriptMode: "normal",
	ompPath: null,
	tourCompleted: false,
	pinnedProjects: [],
	pinnedSessions: [],
	archivedSessions: [],
	extraProjects: [],
	notifications: true,
	voiceInput: false,
};

const file = join(app.getPath("userData"), "preferences.json");
let current: AppPreferences = load();
let pendingWrite: Promise<void> = Promise.resolve();

function load(): AppPreferences {
	try {
		return { ...DEFAULTS, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<AppPreferences>) };
	} catch {
		return { ...DEFAULTS };
	}
}

export function getPrefs(): AppPreferences {
	return current;
}

/** Merge `patch`, persist atomically, and notify renderers. */
export function setPrefs(patch: Partial<AppPreferences>): AppPreferences {
	current = { ...current, ...patch, textScale: Math.min(130, Math.max(90, patch.textScale ?? current.textScale)) };
	const snapshot = JSON.stringify(current, null, 2);
	pendingWrite = pendingWrite.then(async () => {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(`${file}.tmp`, snapshot);
		await rename(`${file}.tmp`, file);
	});
	broadcast("app:prefs", current);
	return current;
}
