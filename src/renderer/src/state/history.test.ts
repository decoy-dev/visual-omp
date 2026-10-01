import { describe, expect, it } from "vitest";
import { activeBranch, extendSessionHistory, parseSessionHistory, savedParents } from "./history";

const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");

describe("parseSessionHistory", () => {
	it("shows only the branch ending at the last entry after a rewind", () => {
		const text = lines(
			{ type: "title", v: 1, title: "Fix coupon bug", pad: "   " },
			{ type: "session", version: 3, id: "s1", cwd: "/p", timestamp: "2026-01-01T00:00:00Z", title: "old title" },
			{ type: "message", id: "a", parentId: null, message: { role: "user", content: "first" } },
			{ type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [] } },
			{ type: "message", id: "c", parentId: "b", message: { role: "user", content: "abandoned branch" } },
			// Rewound to `b`, then continued on a new branch:
			{ type: "message", id: "d", parentId: "b", message: { role: "user", content: "new branch" } },
		);
		const history = parseSessionHistory(text);
		expect(history.entries.map(entry => (entry as { id: string }).id)).toEqual(["a", "b", "d"]);
		expect(history.title).toBe("Fix coupon bug");
		expect(history.header?.id).toBe("s1");
	});

	it("parses a file whose last line has no trailing newline and survives parent cycles", () => {
		const text = lines(
			{ type: "session", version: 3, id: "s2", cwd: "/p", timestamp: "2026-01-01T00:00:00Z" },
			{ type: "message", id: "x", parentId: "y", message: { role: "user", content: "x" } },
			{ type: "message", id: "y", parentId: "x", message: { role: "user", content: "y" } },
		);
		const history = parseSessionHistory(text);
		expect(history.entries.map(entry => (entry as { id: string }).id)).toEqual(["x", "y"]);
		expect(history.title).toBeNull();
	});

	it("extends with appended lines, following a rewind and a renamed title slot, and keeps earlier entries", () => {
		const base = parseSessionHistory(
			lines(
				{ type: "title", v: 1, title: "Old", pad: "" },
				{ type: "session", version: 3, id: "s3", cwd: "/p", timestamp: "2026-01-01T00:00:00Z" },
				{ type: "message", id: "a", parentId: null, message: { role: "user", content: "a" } },
				{ type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [] } },
			),
		);
		const next = extendSessionHistory(
			base,
			`${lines(
				{ type: "title", v: 1, title: "New", pad: "" },
				{ type: "message", id: "c", parentId: "a", message: { role: "user", content: "rewound" } },
			)}\n`,
		);
		expect(next.entries.map(entry => entry.id)).toEqual(["a", "c"]);
		expect(next.entries[0]).toBe(base.entries[0]);
		expect(next.title).toBe("New");
		expect(next.header?.id).toBe("s3");
		expect(extendSessionHistory(next, "")).toBe(next);
	});
});

describe("activeBranch", () => {
	it("keeps the whole chat when the live stream left out the parents omp wrote between entries", () => {
		// omp's collab stream carries messages but not its `custom` entries (`tool_execution_start`,
		// ids t1/t2), so each tool result names a parent the app never receives.
		const live = [
			{ id: "u1", parentId: null },
			{ id: "a1", parentId: "u1" },
			{ id: "r1", parentId: "t1" },
			{ id: "a2", parentId: "r1" },
			{ id: "r2", parentId: "t2" },
			{ id: "a3", parentId: "r2" },
		];
		expect(activeBranch(live).map(entry => entry.id)).toEqual(["u1", "a1", "r1", "a2", "r2", "a3"]);
	});

	it("still drops an abandoned branch when the new branch starts after a missing parent", () => {
		const live = [
			{ id: "u1", parentId: null },
			{ id: "a1", parentId: "u1" },
			{ id: "r1", parentId: "t1" },
			{ id: "u2", parentId: "r1" },
			// Rewound to `a1`, then continued:
			{ id: "u3", parentId: "a1" },
			{ id: "r3", parentId: "t3" },
		];
		expect(activeBranch(live).map(entry => entry.id)).toEqual(["u1", "a1", "u3", "r3"]);
		expect(activeBranch(live, "u2").map(entry => entry.id)).toEqual(["u1", "a1", "r1", "u2"]);
	});

	it("drops the abandoned branch when the chat resumes at an entry the stream left out", () => {
		// u1 → c1 (not streamed) → a1 → u2, then omp moved the leaf back to c1 and appended u3.
		const live = [
			{ id: "u1", parentId: null },
			{ id: "a1", parentId: "c1" },
			{ id: "u2", parentId: "a1" },
			{ id: "u3", parentId: "c1" },
		];
		expect(activeBranch(live).map(entry => entry.id)).toEqual(["u1", "u3"]);
	});

	it("crosses left-out entries through the saved file's ancestry when it has them", () => {
		// The leaf moved to c2 (saved, not streamed, child of a1) that had no streamed child before u3,
		// so arrival order alone would wrongly keep x1 from the abandoned branch.
		const live = [
			{ id: "u1", parentId: null },
			{ id: "a1", parentId: "u1" },
			{ id: "x1", parentId: "a1" },
			{ id: "u3", parentId: "c2" },
		];
		const history = parseSessionHistory(
			lines(
				{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "u1" } },
				{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } },
				{ type: "message", id: "x1", parentId: "a1", message: { role: "user", content: "x1" } },
				{ type: "custom", id: "c2", parentId: "a1", customType: "label" },
			),
		);
		expect(activeBranch(live).map(entry => entry.id)).toEqual(["u1", "a1", "x1", "u3"]);
		expect(activeBranch(live, null, savedParents(history)).map(entry => entry.id)).toEqual(["u1", "a1", "u3"]);
	});
});
