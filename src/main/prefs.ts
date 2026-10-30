import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import { DEFAULT_SIDEBAR_SORT, type AppPreferences, type SidebarSort } from "@shared/ipc";
import type { NewUserApproval } from "./services/approval-default";
import { broadcast } from "./ipc";

/** Main-only state stored with the preferences. */
interface StoredPreferences extends AppPreferences {
	/** The first-run "Ask me first" default (services/approval-default.ts); absent on profiles that predate it. */
	newUserApproval?: NewUserApproval;
	/** Legacy app pins, removed after their one-time migration into omp's pin file. */
	pinnedSessions?: string[];
	/** Highest version left by a rollback; older releases safely retain this unknown preference. */
	appUpdateSkipThrough: string | null;
}

const DEFAULTS: AppPreferences = {
	theme: "light",
	textScale: 100,
	reducedMotion: "system",
	transcriptMode: "normal",
	liveThinking: true,
	ompPath: null,
	// Existing or unreadable profiles keep setup complete; only a missing file starts setup.
	setupCompleted: true,
	tourCompleted: false,
	pinnedProjects: [],
	sidebarSort: DEFAULT_SIDEBAR_SORT,
	archivedSessions: [],
	extraProjects: [],
	projectColors: {},
	notifications: true,
	voiceInput: false,
};

const file = join(app.getPath("userData"), "preferences.json");
let current: StoredPreferences = load();
let pendingWrite: Promise<void> = Promise.resolve();

function sidebarSort(value: unknown): SidebarSort {
	const stored = value && typeof value === "object" ? value as Partial<SidebarSort> : {};
	return {
		by: stored.by === "name" || stored.by === "created" || stored.by === "recent" ? stored.by : DEFAULT_SIDEBAR_SORT.by,
		groupByProject: typeof stored.groupByProject === "boolean" ? stored.groupByProject : DEFAULT_SIDEBAR_SORT.groupByProject,
	};
}

function load(): StoredPreferences {
	try {
		const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredPreferences>;
		return { appUpdateSkipThrough: null, ...DEFAULTS, ...stored, sidebarSort: sidebarSort(stored.sidebarSort) };
	} catch (error) {
		// No preferences file yet: a fresh profile, so the new-user approval default is still to run.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { appUpdateSkipThrough: null, ...DEFAULTS, setupCompleted: false, newUserApproval: "pending" };
		return { appUpdateSkipThrough: null, ...DEFAULTS };
	}
}

export function getPrefs(): StoredPreferences {
	return current;
}

/** Merge `patch`, persist atomically, and notify renderers. */
export function setPrefs(patch: Partial<StoredPreferences>): StoredPreferences {
	current = {
		...current,
		...patch,
		sidebarSort: sidebarSort(patch.sidebarSort === undefined ? current.sidebarSort : patch.sidebarSort),
		textScale: Math.min(130, Math.max(90, patch.textScale ?? current.textScale)),
	};
	const snapshot = JSON.stringify(current, null, 2);
	// A failed flush must still allow a subsequent write to restore the previous rollback boundary.
	pendingWrite = pendingWrite.catch(() => {}).then(async () => {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(`${file}.tmp`, snapshot);
		await rename(`${file}.tmp`, file);
	});
	broadcast("app:prefs", current);
	return current;
}

/** Wait until the current preferences have been persisted before an installer can close the app. */
export function flushPrefs(): Promise<void> {
	return pendingWrite;
}

/** Clear only after omp has confirmed every legacy pin, so a failed migration remains retryable. */
export function finishSessionPinMigration(): void {
	setPrefs({ pinnedSessions: undefined });
}
