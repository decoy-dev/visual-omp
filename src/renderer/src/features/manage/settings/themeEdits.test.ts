import type { AppPreferences } from "@shared/ipc";
import { presetTheme } from "@shared/themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { useThemePreview } from "@/theme/preview";
import { copyTheme, setThemeColor } from "./colorThemes";
import { deleteTheme, flushEdit, queueEdit, renameTheme, SAVE_DELAY_MS } from "./themeEdits";

interface Store {
	prefs: AppPreferences | null;
	setPrefs(patch: Partial<AppPreferences>): Promise<void>;
}

const store = vi.hoisted(() => ({ app: null as unknown as UseBoundStore<StoreApi<Store>>, writes: [] as Partial<AppPreferences>[], gates: [] as (() => void)[], hold: false }));
vi.mock("@/state/app", () => ({ get useApp() { return store.app; } }));
const toasts = vi.hoisted(() => [] as { tone?: string; message: string; description?: string }[]);
// Settings may be gone when a save fails (a flush on leaving it, Undo from its toast), so failures toast on their own.
vi.mock("@/ui", () => ({ toast: (options: { tone?: string; message: string; description?: string }) => toasts.push(options) }));
vi.mock("@/i18n", () => ({ i18n: { t: (key: string) => key } }));

const ocean = presetTheme("ocean")!;
const themeA = copyTheme(ocean, "Alpha", ocean.id);
const themeB = copyTheme(ocean, "Bravo", ocean.id);

/** While `hold` is set, preferences writes resolve when the test releases them, in order, as main applies them. */
function release(): void {
	store.gates.shift()?.();
}

beforeEach(() => {
	vi.useFakeTimers();
	store.writes = [];
	store.gates = [];
	store.hold = false;
	store.app = create<Store>((set, get) => ({
		prefs: { colorTheme: themeA.id, customThemes: [themeA, themeB] } as AppPreferences,
		async setPrefs(patch) {
			store.writes.push(patch);
			if (store.hold) {
				const gate = Promise.withResolvers<void>();
				store.gates.push(gate.resolve);
				await gate.promise;
			}
			set({ prefs: { ...get().prefs!, ...patch } });
		},
	}));
	useThemePreview.setState({ theme: null });
});
afterEach(() => vi.useRealTimers());

const prefs = () => store.app.getState().prefs!;
const settle = async () => {
	for (let index = 0; index < 20; index++) await Promise.resolve();
};

describe("theme edits", () => {
	it("saves a color edit once after the delay, then clears the preview", async () => {
		queueEdit(setThemeColor(themeA, "light", "accent", "#112233"));
		queueEdit(setThemeColor(themeA, "light", "accent", "#445566"));
		expect(store.writes).toEqual([]);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
		expect(store.writes).toHaveLength(1);
		expect(prefs().customThemes[0]!.light.accent).toBe("#445566");
		expect(useThemePreview.getState().theme).toBeNull();
	});

	it("keeps a rename made while a color edit waits, and the edit's colors", async () => {
		queueEdit(setThemeColor(themeA, "dark", "text", "#eeeeee"));
		await renameTheme(themeA.id, "Night");
		expect(prefs().customThemes.find(theme => theme.id === themeA.id)).toMatchObject({ name: "Night", dark: { text: "#eeeeee" } });
		// A later edit carries the old name in its copy, and the save keeps the stored name.
		queueEdit(setThemeColor(themeA, "dark", "text", "#dddddd"));
		await flushEdit();
		expect(prefs().customThemes.find(theme => theme.id === themeA.id)).toMatchObject({ name: "Night", dark: { text: "#dddddd" } });
	});

	it("undoes a delete after a slower save, putting back only that theme in its place", async () => {
		const undo = await deleteTheme(themeA.id);
		expect(prefs().customThemes.map(theme => theme.id)).toEqual([themeB.id]);
		expect(prefs().colorTheme).toBe(ocean.id);
		store.hold = true;
		queueEdit(setThemeColor(themeB, "light", "accent", "#abcdef"));
		const saving = flushEdit();
		const undoing = undo!();
		await settle();
		// Bravo's save is still in flight, so Undo has not written yet.
		expect(store.writes).toHaveLength(2);
		release();
		await saving;
		await settle();
		release();
		await undoing;
		expect(prefs().customThemes.map(theme => [theme.id, theme.light.accent])).toEqual([[themeA.id, themeA.light.accent], [themeB.id, "#abcdef"]]);
		// Bravo's edit selected it after the delete, so Undo leaves the selection alone.
		expect(prefs().colorTheme).toBe(themeB.id);
	});

	it("drops an edit made while that theme's delete was being saved", async () => {
		store.hold = true;
		const deleting = deleteTheme(themeA.id);
		await settle();
		// The delete is in flight; the screen still shows Alpha, and a color changes.
		queueEdit(setThemeColor(themeA, "light", "accent", "#000000"));
		release();
		await deleting;
		store.hold = false;
		await flushEdit();
		expect(prefs().customThemes.map(theme => theme.id)).toEqual([themeB.id]);
		expect(useThemePreview.getState().theme).toBeNull();
	});

	it("toasts a failed save without Settings on screen and keeps the edit", async () => {
		toasts.length = 0;
		store.app.setState({ setPrefs: async () => { throw new Error("disk full"); } });
		// Bravo: an earlier test deleted Alpha, and the module keeps that for the session.
		const edit = setThemeColor(themeB, "light", "accent", "#123123");
		queueEdit(edit);
		// Leaving Settings flushes the waiting edit; nothing in Settings listens any more.
		expect(await flushEdit()).toBe(false);
		expect(toasts).toEqual([{ tone: "err", message: "settings:appearance.colors.saveFailed", description: "disk full" }]);
		expect(useThemePreview.getState().theme).toBe(edit);
	});

	it("toasts an Undo that fails after Settings closed", async () => {
		toasts.length = 0;
		useThemePreview.setState({ theme: null });
		const undo = await deleteTheme(themeB.id);
		store.app.setState({ setPrefs: async () => { throw new Error("read-only profile"); } });
		expect(await undo!()).toBe(false);
		expect(toasts).toEqual([{ tone: "err", message: "settings:appearance.colors.saveFailed", description: "read-only profile" }]);
	});
});
