import { describe, expect, it } from "vitest";
import { parseSessionHistory } from "./history";

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
});
