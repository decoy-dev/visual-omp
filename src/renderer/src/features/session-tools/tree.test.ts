import { describe, expect, it } from "vitest";
import { layoutTree, parseSessionTree, pathTo, rowProbe, selectorRows } from "./tree";

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

	it("uses the replayed leaf for tree markers and keyboard navigation after an off-branch tail", () => {
		const late = entry("late", "a2", "message", "2026-01-01T00:00:06Z", {
			activeLeafId: "a3", message: { role: "toolResult", content: [] },
		});
		const tree = parseSessionTree(`${session}\n${late}`);
		expect(tree.leafId).toBe("a3");
		expect(selectorRows(tree, "user").map(item => item.id)).toEqual(["u1", "u3", "u2"]);
		expect(layoutTree(tree).nodes.find(node => node.id === "a3")?.current).toBe(true);
		expect(parseSessionTree(`${session}\n${entry("clear", "a2", "custom", "", { activeLeafId: null })}`).leafId).toBeNull();
		expect(parseSessionTree(`${session}\n${entry("missing", "a2", "custom", "", { activeLeafId: "removed" })}`).leafId).toBe("a3");
	});

	it("maps both branches while preserving active and current markers", () => {
		const map = layoutTree(parseSessionTree(session));
		expect(map.branched).toBe(true);
		expect(map.nodes.find(node => node.id === "a3")).toMatchObject({ active: true, current: true });
		expect(map.nodes.find(node => node.id === "a2")).toMatchObject({ active: false, current: false });
	});

	it("shows omp notices by their summary and a skill turn by what the user typed", () => {
		const tree = parseSessionTree(
			[
				entry("u1", null, "message", "2026-01-01T00:00:00Z", { message: { role: "user", content: "start" } }),
				entry("n1", "u1", "custom_message", "2026-01-01T00:00:01Z", {
					customType: "irc:incoming",
					display: true,
					content: "<irc>\nIncoming IRC message from agent `Sec05`:\n\nDone with section 5.\n</irc>",
					details: { from: "Sec05", message: "Done with section 5." },
				}),
				entry("s1", "n1", "custom_message", "2026-01-01T00:00:02Z", {
					customType: "skill-prompt",
					display: true,
					attribution: "user",
					content: '[IMPORTANT: User invoked the "redesign" skill; follow its instructions. Full skill below.]\n\n# Redesign\n\n---\n\n[Skill directory: /s]\nResolve paths.\nUser: tidy the header',
					details: { name: "redesign", path: "/s/SKILL.md", args: "tidy the header", lineCount: 1 },
				}),
			].join("\n"),
		);
		const notice = tree.entries.get("n1");
		expect(notice?.text).toBe(notice?.summary);
		expect(notice?.text).toContain("Sec05");
		expect(notice?.text).toContain("Done with section 5.");
		expect(notice?.text).not.toMatch(/<irc>|Incoming IRC/);
		const skill = layoutTree(tree).nodes.find(node => node.id === "s1");
		expect(skill?.kind).toBe("user");
		expect(skill?.text).toBe("tidy the header");
		expect(skill?.label).toContain("redesign");
		expect(skill?.label).not.toContain("IMPORTANT");
	});

	it("reads a user's message as the transcript shows it: text blocks by line, images left out", () => {
		const image = { type: "image", data: "blob:sha256:abc", mimeType: "image/png" };
		const tree = parseSessionTree(
			[
				entry("u1", null, "message", "2026-01-01T00:00:00Z", {
					message: { role: "user", content: [{ type: "text", text: "first" }, image, { type: "text", text: "second" }, image] },
				}),
				entry("c1", "u1", "custom_message", "2026-01-01T00:00:01Z", {
					customType: "collab-prompt",
					attribution: "user",
					content: [image, { type: "text", text: "from" }, { type: "text", text: "a guest" }],
				}),
				entry("a1", "c1", "message", "2026-01-01T00:00:02Z", {
					message: { role: "assistant", content: [{ type: "text", text: "Part one. " }, { type: "text", text: "Part two." }] },
				}),
			].join("\n"),
		);
		const user = tree.entries.get("u1");
		expect(user?.text).toBe("first\nsecond");
		// omp's `/tree` row runs the text blocks together ("user: firstsecond"); the probe is a prefix of that row.
		expect(user && rowProbe(user)).toBe("user: first");
		expect(tree.entries.get("c1")?.text).toBe("from\na guest");
		// Assistant text keeps its own extraction, blocks run together.
		expect(tree.entries.get("a1")?.text).toBe("Part one. Part two.");
	});
});
