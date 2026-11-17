import { EventEmitter } from "node:events";
import type { MessageBoxOptions } from "electron";
import hostLabels from "../../../../shared/i18n/en/host.json";

/** Only desktop presentation, preferences and launch selection are adapted for the headless probe. */
export const lifecyclePlatform = {
	env: {} as Record<string, string>,
	confirmations: [] as { message: string; response: number }[],
	/** Set by the probe inside its scratch root; SessionHost keeps per-chat compaction points there. */
	userData: "",
};
export const app = {
	getPath(name: string) {
		if (name !== "userData" || !lifecyclePlatform.userData) throw new Error(`Unexpected lifecycle probe path: ${name}`);
		return lifecyclePlatform.userData;
	},
};
export const BrowserWindow = { getFocusedWindow: () => null, getAllWindows: () => [] };
export const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
export const systemPreferences = { getAnimationSettings: () => ({ prefersReducedMotion: false }) };
export const dialog = {
	async showMessageBox(...args: unknown[]) {
		const options = args.at(-1) as MessageBoxOptions;
		if (options.message !== hostLabels.shutdownTitle || options.buttons?.[1] !== hostLabels.stopNow) {
			throw new Error(`Unexpected lifecycle probe dialog: ${options.message}`);
		}
		lifecyclePlatform.confirmations.push({ message: options.message, response: 1 });
		return { response: 1, checkboxChecked: false };
	},
};
export async function userEnv() { return lifecyclePlatform.env; }
export function ptyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
export async function ompPath() {
	if (!process.env.OMP_BIN) throw new Error("OMP_BIN is required for the lifecycle probe");
	return process.env.OMP_BIN;
}
const preferences = { theme: "light", reducedMotion: "off", archivedSessions: [], extraProjects: [], pinnedSessions: undefined };
export function getPrefs() { return preferences; }
export function finishSessionPinMigration() { preferences.pinnedSessions = undefined; }
export function broadcast() { /* This headless process has no renderer. SessionHost state remains observable directly. */ }
