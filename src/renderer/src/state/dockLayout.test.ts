import { describe, expect, it } from "vitest";
import {
	DEFAULT_DOCK,
	DOCK_MAX_WIDTH,
	DOCK_MIN_WIDTH,
	dockScope,
	keepLayouts,
	keepsChatOpen,
	layoutFor,
	moveLayout,
	OVERVIEW_DOCK,
	restoreLayouts,
	withLayout,
} from "./dockLayout";

describe("dockScope", () => {
	it("is the focused chat's in the chat view and on a page opened from it", () => {
		expect(dockScope("chat", "home", "a")).toBe("a");
		expect(dockScope("page", "chat", "a")).toBe("a");
	});

	it("is the overview's everywhere else", () => {
		expect(dockScope("project", "home", "a")).toBe(OVERVIEW_DOCK);
		expect(dockScope("home", "home", "a")).toBe(OVERVIEW_DOCK);
		expect(dockScope("page", "project", "a")).toBe(OVERVIEW_DOCK);
		expect(dockScope("chat", "home", null)).toBe(OVERVIEW_DOCK);
	});
});

describe("withLayout", () => {
	it("shows a chat that never touched its panel closed at the default width", () => {
		expect(layoutFor({}, "a")).toEqual(DEFAULT_DOCK);
	});

	it("opening, choosing a pane and resizing in one chat leaves another as it was", () => {
		let docks = withLayout({}, "a", { open: true, pane: "tasks" });
		docks = withLayout(docks, "a", { width: 560 });
		docks = withLayout(docks, "b", { open: true, pane: "files" });
		expect(layoutFor(docks, "a")).toEqual({ open: true, pane: "tasks", width: 560 });
		expect(layoutFor(docks, "b")).toEqual({ open: true, pane: "files", width: DEFAULT_DOCK.width });
		expect(layoutFor(docks, "c")).toEqual(DEFAULT_DOCK);
	});

	it("keeps the width inside the panel's limits", () => {
		expect(layoutFor(withLayout({}, "a", { width: 9000 }), "a").width).toBe(DOCK_MAX_WIDTH);
		expect(layoutFor(withLayout({}, "a", { width: 10 }), "a").width).toBe(DOCK_MIN_WIDTH);
	});

	it("returns the same map when nothing changes and drops a layout that is the default again", () => {
		const docks = withLayout({}, "a", { open: true });
		expect(withLayout(docks, "a", { open: true })).toBe(docks);
		expect(withLayout(docks, "a", { open: false })).toEqual({});
	});
});

describe("keepLayouts and moveLayout", () => {
	it("drops what a closed chat had and keeps the overview's", () => {
		const docks = { a: { ...DEFAULT_DOCK, open: true }, b: { ...DEFAULT_DOCK, open: true }, [OVERVIEW_DOCK]: { ...DEFAULT_DOCK, open: true } };
		expect(Object.keys(keepLayouts(docks, ["b"]))).toEqual(["b", OVERVIEW_DOCK]);
		expect(keepLayouts(docks, ["a", "b"])).toBe(docks);
	});

	it("moves a chat's layout to its new id", () => {
		const docks = { a: { ...DEFAULT_DOCK, open: true } };
		expect(moveLayout(docks, "a", "a2")).toEqual({ a2: { ...DEFAULT_DOCK, open: true } });
		expect(moveLayout(docks, "x", "y")).toBe(docks);
	});
});

describe("keepsChatOpen", () => {
	it("keeps a viewed chat open while its panel is open or resized, not for a pane choice alone", () => {
		expect(keepsChatOpen(DEFAULT_DOCK)).toBe(false);
		expect(keepsChatOpen({ ...DEFAULT_DOCK, pane: "tasks" })).toBe(false);
		expect(keepsChatOpen({ ...DEFAULT_DOCK, open: true })).toBe(true);
		expect(keepsChatOpen({ ...DEFAULT_DOCK, width: 500 })).toBe(true);
	});
});

describe("restoreLayouts", () => {
	it("reads back the restored chats' layouts and drops malformed ones and chats that are gone", () => {
		const saved = JSON.parse(
			JSON.stringify({
				a: { open: true, pane: "tasks", width: 500 },
				gone: { open: true, pane: "files", width: 500 },
				broken: { open: "yes", pane: 3 },
				[OVERVIEW_DOCK]: { open: true, pane: "diff", width: 9000 },
			}),
		);
		expect(restoreLayouts(saved, ["a", "broken"])).toEqual({
			a: { open: true, pane: "tasks", width: 500 },
			[OVERVIEW_DOCK]: { open: true, pane: "diff", width: DOCK_MAX_WIDTH },
		});
		expect(restoreLayouts(undefined, ["a"])).toEqual({});
	});
});
