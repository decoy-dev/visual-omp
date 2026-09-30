import { describe, expect, it } from "vitest";
import { extendSessionHistory, parseSessionHistory } from "./history";

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
