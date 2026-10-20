import { describe, expect, it } from "vitest";
import { normalizeRestoredChatSelection, type RestoredChatSelection, releaseKeepsNumbers } from "./chatSelection";

interface Tab { id: string; projectPath: string }
const tab = (id: string, projectPath = id): Tab => ({ id, projectPath });
const selection = (tabs: Tab[], patch: Partial<RestoredChatSelection<Tab>> = {}) => normalizeRestoredChatSelection({
	tabs,
	activeTabId: null,
	splitTabId: null,
	focusedSplit: "primary",
	activeProject: null,
	...patch,
});

describe("normalizeRestoredChatSelection", () => {
	it("keeps a valid split", () => {
		expect(selection([tab("a"), tab("b")], { activeTabId: "a", splitTabId: "b", focusedSplit: "secondary" })).toMatchObject({
			activeTabId: "a",
			splitTabId: "b",
			focusedSplit: "secondary",
		});
	});

	it("keeps the project last shown, even with a chat from another project open", () => {
		expect(selection([tab("a", "project-a")], { activeTabId: "a", activeProject: "project-b" })).toMatchObject({
			activeTabId: "a",
			activeProject: "project-b",
		});
	});

	it("takes the focused chat's project when none was saved", () => {
		expect(selection([tab("a", "project-a"), tab("b", "project-b")], { activeTabId: "a", splitTabId: "b", focusedSplit: "secondary" })).toMatchObject({
			activeProject: "project-b",
		});
	});

	it("promotes a surviving split chat when the primary chat had no saved session", () => {
		expect(selection([tab("saved", "work")], {
			activeTabId: "unsaved",
			splitTabId: "saved",
			focusedSplit: "secondary",
		})).toMatchObject({ activeTabId: "saved", splitTabId: null, focusedSplit: "primary", activeProject: "work" });
	});

	it("clears stale split ids and chooses a surviving chat when the active id is missing", () => {
		expect(selection([tab("a"), tab("b")], {
			activeTabId: "gone",
			splitTabId: "also-gone",
			focusedSplit: "secondary",
		})).toMatchObject({ activeTabId: "b", splitTabId: null, focusedSplit: "primary" });
	});

	it("clears the selection when no saved chat can be restored", () => {
		expect(selection([], {
			activeTabId: "unsaved",
			splitTabId: "gone",
		})).toMatchObject({ activeTabId: null, splitTabId: null, focusedSplit: "primary" });
	});
});

describe("releaseKeepsNumbers", () => {
	it("releases a browsed preview when the next chat opened after it is new", () => {
		const before = [tab("a"), tab("preview")];
		expect(releaseKeepsNumbers("preview", [...before, tab("next")], before)).toBe(true);
	});

	it("releases a preview at the end of the list", () => {
		const tabs = [tab("a"), tab("preview")];
		expect(releaseKeepsNumbers("preview", tabs, tabs)).toBe(true);
	});

	it("keeps a preview when a chat that was already open sits after it", () => {
		// Opened B beside the preview earlier, then chose A: releasing the preview would move B from ⌘3 to ⌘2.
		const tabs = [tab("a"), tab("preview"), tab("b")];
		expect(releaseKeepsNumbers("preview", tabs, tabs)).toBe(false);
	});

	it("does nothing for a chat that is not open", () => {
		expect(releaseKeepsNumbers("gone", [tab("a")], [tab("a")])).toBe(false);
	});
});
