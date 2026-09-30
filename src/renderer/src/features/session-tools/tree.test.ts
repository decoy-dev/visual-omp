import { describe, expect, it } from "vitest";
import { layoutTree, parseSessionTree, pathTo, selectorRows } from "./tree";

function entry(id: string, parentId: string | null, type: string, timestamp: string, extra: Record<string, unknown> = {}) {
	return JSON.stringify({ id, parentId, type, timestamp, ...extra });
}

const session = [
	JSON.stringify({ type: "session", id: "s", cwd: "/tmp" }),
	entry("u1", null, "message", "2026-01-01T00:00:00Z", { message: { role: "user", content: "build a widget" } }),
	entry("a1", "u1", "message", "2026-01-01T00:00:01Z", { message: { role: "assistant", content: [{ type: "text", text: "First approach." }] } }),
	entry("u2", "a1", "message", "2026-01-01T00:00:02Z", { message: { role: "user", content: "make it smaller" } }),
	entry("a2", "u2", "message", "2026-01-01T00:00:03Z", { message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
	entry("u3", "a1", "message", "2026-01-01T00:00:04Z", { message: { role: "user", content: "try a different shape" } }),
	entry("a3", "u3", "message", "2026-01-01T00:00:05Z", { message: { role: "assistant", content: [{ type: "text", text: "Second approach." }] } }),
].join("\n");

describe("session tree model", () => {
	it("parses every branch and puts the current branch first for selector navigation", () => {
		const tree = parseSessionTree(session);
		expect(tree.leafId).toBe("a3");
		expect(pathTo(tree, "a3").map(item => item.id)).toEqual(["u1", "a1", "u3", "a3"]);
		expect(selectorRows(tree, "user").map(item => item.id)).toEqual(["u1", "u3", "u2"]);
		expect(selectorRows(tree, "all")[0]?.id).toBe("u1");
	});

	it("maps both branches while preserving active and current markers", () => {
		const map = layoutTree(parseSessionTree(session));
		expect(map.branched).toBe(true);
		expect(map.nodes.find(node => node.id === "a3")).toMatchObject({ active: true, current: true });
		expect(map.nodes.find(node => node.id === "a2")).toMatchObject({ active: false, current: false });
	});
});
