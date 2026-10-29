import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { AppPreferences } from "@shared/ipc";
import type { NewUserApproval } from "./services/approval-default";
import { broadcast } from "./ipc";

/** Main-only state stored with the preferences. */
interface StoredPreferences extends AppPreferences {
	/** The first-run "Ask me first" default (services/approval-default.ts); absent on profiles that predate it. */
	newUserApproval?: NewUserApproval;
	/** Legacy app pins, removed after their one-time migration into omp's pin file. */
	pinnedSessions?: string[];
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
	archivedSessions: [],
	extraProjects: [],
	projectColors: {},
	notifications: true,
	voiceInput: false,
};

const file = join(app.getPath("userData"), "preferences.json");
let current: StoredPreferences = load();
let pendingWrite: Promise<void> = Promise.resolve();

function load(): StoredPreferences {
	try {
		return { ...DEFAULTS, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<StoredPreferences>) };
	} catch (error) {
		// No preferences file yet: a fresh profile, so the new-user approval default is still to run.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULTS, setupCompleted: false, newUserApproval: "pending" };
		return { ...DEFAULTS };
	}
}

export function getPrefs(): StoredPreferences {
	return current;
}

/** Merge `patch`, persist atomically, and notify renderers. */
export function setPrefs(patch: Partial<StoredPreferences>): StoredPreferences {
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

/** Clear only after omp has confirmed every legacy pin, so a failed migration remains retryable. */
export function finishSessionPinMigration(): void {
	setPrefs({ pinnedSessions: undefined });
}
