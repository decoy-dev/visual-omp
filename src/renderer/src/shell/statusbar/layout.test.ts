import { describe, expect, it } from "vitest";
import { DEFAULT_STATUS_BAR } from "@shared/statusBar";
import type { StatusItemSpec } from "../../registry/slots";
import { orderedStatusItems, visibleStatusItems } from "./layout";
import { moveStatusItem, showStatusItem } from "./customize";
import { normalizeStatusBar } from "@shared/statusBarPreference";

const items: StatusItemSpec[] = [
	{ id: "git.branch", title: "branch", side: "left", order: 10, component: () => null },
	{ id: "git.changes", title: "changes", side: "left", order: 20, component: () => null },
	{ id: "chat.context", title: "context", side: "left", order: 30, component: () => null },
	{ id: "app.update", title: "update", side: "right", order: 10, component: () => null },
	{ id: "omp.status", title: "omp", side: "right", order: 20, component: () => null },
	{ id: "app.cpu", title: "cpu", side: "right", order: 30, component: () => null },
];

describe("status registry layout", () => {
	it("keeps today's order and hides the new optional metrics by default", () => {
		expect(visibleStatusItems(items, DEFAULT_STATUS_BAR).map(item => item.id)).toEqual(["git.branch", "git.changes", "app.update", "omp.status", "app.cpu"]);
	});
	it("orders each side by saved ids, appending new registrations in registry order", () => {
		expect(orderedStatusItems(items, { hidden: [], order: ["app.cpu", "missing", "git.changes", "git.branch"] }).map(item => item.id)).toEqual(["git.changes", "git.branch", "chat.context", "app.cpu", "app.update", "omp.status"]);
	});
	it("cannot hide recovery actions even when preference or registration omits their lock", () => {
		const preference = { hidden: items.map(item => item.id), order: [] };
		expect(visibleStatusItems(items, preference).map(item => item.id)).toEqual(["app.update", "omp.status"]);
		for (const item of items.filter(item => item.id === "omp.status" || item.id === "app.update")) expect(showStatusItem(preference, item, false).hidden).not.toContain(item.id);
	});
	it("shows and hides optional entries without changing the saved order", () => {
		const initial = normalizeStatusBar({ hidden: ["app.cpu"], order: ["app.cpu", "omp.status"] });
		const shown = showStatusItem(initial, items[5]!, true);
		expect(shown).toEqual({ ...initial, hidden: ["chat.cache"] });
		const hidden = showStatusItem(shown, items[5]!, false);
		expect(new Set(hidden.hidden)).toEqual(new Set(initial.hidden));
		expect(hidden.order).toEqual(initial.order);
	});
	it("reorders hidden items within their side and preserves the other side", () => {
		const next = moveStatusItem(items, DEFAULT_STATUS_BAR, "chat.context", 0);
		expect(orderedStatusItems(items, next).map(item => item.id)).toEqual(["chat.context", "git.branch", "git.changes", "app.update", "omp.status", "app.cpu"]);
		expect(next.hidden).toBe(DEFAULT_STATUS_BAR.hidden);
		expect(moveStatusItem(items, next, "chat.context", -1)).toBe(next);
		expect(moveStatusItem(items, next, "missing", 0)).toBe(next);
	});
});
