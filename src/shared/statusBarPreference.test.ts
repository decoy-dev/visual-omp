import { expect, it } from "vitest";
import { DEFAULT_STATUS_BAR, OPTIONAL_STATUS_ITEMS, STATUS_BAR_ITEMS_078, STATUS_BAR_KNOWN_ITEMS } from "./statusBar";
import { normalizeStatusBar } from "./statusBarPreference";

it("keeps fresh preferences unchanged", () => {
	expect(normalizeStatusBar(undefined)).toEqual(DEFAULT_STATUS_BAR);
	expect(normalizeStatusBar(DEFAULT_STATUS_BAR)).toEqual(DEFAULT_STATUS_BAR);
	expect(DEFAULT_STATUS_BAR.hidden).toEqual(OPTIONAL_STATUS_ITEMS);
});
it("retains 0.7.8 visibility and ordering while applying cache's default once", () => {
	const migrated = normalizeStatusBar({ hidden: ["app.cpu", "chat.model"], order: ["git.pr", "git.branch"] });
	expect(migrated).toEqual({ hidden: ["app.cpu", "chat.model", "chat.cache"], order: ["git.pr", "git.branch"], seen: STATUS_BAR_KNOWN_ITEMS });
	expect(STATUS_BAR_ITEMS_078).not.toContain("chat.cache");
	const enabled = { ...migrated, hidden: migrated.hidden.filter(id => id !== "chat.cache") };
	expect(normalizeStatusBar(JSON.parse(JSON.stringify(enabled)))).toEqual(enabled);
});
it("applies the default for unseen ids and preserves known choices and unknown saved ids", () => {
	const migrated = normalizeStatusBar({ hidden: [], order: ["future.item"], seen: [...STATUS_BAR_ITEMS_078, "future.item"] });
	expect(migrated.hidden).toEqual(["chat.cache"]);
	expect(migrated.order).toEqual(["future.item"]);
	expect(migrated.seen).toContain("future.item");
	expect(migrated.seen).toContain("chat.cache");
});
it("normalizes damaged seen ids without ever hiding recovery controls", () => {
	const migrated = normalizeStatusBar({ hidden: ["omp.status", "app.update", "chat.cache"], seen: [null, "", "chat.cache", "chat.cache"], order: [] });
	expect(migrated.hidden).not.toContain("omp.status");
	expect(migrated.hidden).not.toContain("app.update");
	expect(migrated.seen?.filter(id => id === "chat.cache")).toHaveLength(1);
	expect(migrated.seen).not.toContain(null);
});
