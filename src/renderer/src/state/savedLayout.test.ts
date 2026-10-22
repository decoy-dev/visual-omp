import { describe, expect, it } from "vitest";
import { OVERVIEW_DOCK } from "./dockLayout";
import { migrateSavedLayout, readSavedLayout } from "./savedLayout";

const tab = { id: "a", projectPath: "/p", sessionFile: "/s/a.jsonl", title: null };

describe("readSavedLayout", () => {
	it("reads nothing from a saved state that is not an object", () => {
		expect(readSavedLayout(null)).toEqual({});
		expect(readSavedLayout("layout")).toEqual({});
		expect(readSavedLayout([tab])).toEqual({});
	});

	it("keeps the valid chats and drops null, damaged and unsaved ones", () => {
		const read = readSavedLayout({ tabs: [null, tab, { id: 3 }, { ...tab, id: "n", sessionFile: null }], activeTabId: "a" });
		expect(read.tabs).toEqual([tab]);
		expect(read.activeTabId).toBe("a");
	});

	it("leaves out fields of the wrong type so their defaults stay", () => {
		const read = readSavedLayout({ tabs: "a", activeTabId: 4, focusedSplit: "left", sidebarOpen: "yes", sidebarWidth: "wide", expandedProjects: [1] });
		expect(read).toEqual({ tabs: [], activeTabId: null, splitTabId: null, focusedSplit: "primary", activeProject: null, docks: {} });
	});

	it("restores the side panels of the chats it keeps", () => {
		const docks = { a: { open: true, pane: "tasks", width: 500 }, gone: { open: true, pane: "files", width: 500 } };
		expect(readSavedLayout({ tabs: [tab], docks }).docks).toEqual({ a: { open: true, pane: "tasks", width: 500 } });
	});
});

describe("migrateSavedLayout", () => {
	it("gives the old shared layout to the overview, so restored chats start closed", () => {
		expect(migrateSavedLayout({ tabs: [], dockOpen: true, dockPane: "files", dockWidth: 500 })).toEqual({
			tabs: [],
			docks: { [OVERVIEW_DOCK]: { open: true, pane: "files", width: 500 } },
		});
		expect(migrateSavedLayout({ dockOpen: false, dockPane: "diff", dockWidth: 420 })).toEqual({ docks: {} });
	});

	it("reads anything else as an empty layout", () => {
		expect(migrateSavedLayout(null)).toEqual({});
		expect(migrateSavedLayout(["a"])).toEqual({});
		expect(migrateSavedLayout({ dockOpen: "yes" })).toEqual({ docks: {} });
	});
});
