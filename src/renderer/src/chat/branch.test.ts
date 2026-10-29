import { describe, expect, it, vi } from "vitest";
import { displayedEntries } from "./branch";
import type { SessionView } from "../state/session";
import { parseSessionHistory } from "../state/history";

vi.mock("../state/session", () => ({
	liveEntries: (view: SessionView) => view.guest?.entries ?? view.carryover ?? null,
}));

const entries = [
	{ type: "message", id: "a", parentId: null, message: { role: "user", content: "first" } },
	{ type: "message", id: "abandoned", parentId: "a", message: { role: "assistant", content: [] } },
	{ type: "message", id: "current", parentId: "a", message: { role: "user", content: "current" } },
	{ type: "message", id: "late", parentId: "abandoned", activeLeafId: "current", message: { role: "toolResult", content: [] } },
];
const view = (displayLeaf: string | null, carryover = false) => ({
	guest: carryover ? null : { entries }, carryover: carryover ? entries : null, displayLeaf, history: null,
}) as unknown as SessionView;

describe("displayedEntries", () => {
	it("uses the recorded active leaf for live and reconnecting mirrors", () => {
		expect(displayedEntries(view(null)).map(entry => entry.id)).toEqual(["a", "current"]);
		expect(displayedEntries(view(null, true)).map(entry => entry.id)).toEqual(["a", "current"]);
	});

	it("keeps an explicit tree selection ahead of the replayed leaf", () => {
		expect(displayedEntries(view("abandoned")).map(entry => entry.id)).toEqual(["a", "abandoned"]);
	});

	it("bridges a captured leaf omitted from collab through parsed saved ancestry", () => {
		const live = [entries[0], entries[1], { ...entries[3], activeLeafId: "c" }];
		const history = parseSessionHistory([
			entries[0], entries[1], { type: "custom", id: "c", parentId: "a", customType: "tool_execution_start" },
		].map(entry => JSON.stringify(entry)).join("\n"));
		const snapshot = { ...view(null), guest: { entries: live }, history } as unknown as SessionView;
		expect(displayedEntries(snapshot).map(entry => entry.id)).toEqual(["a"]);
		const unknown = { ...snapshot, guest: { entries: [...live.slice(0, 2), { ...live[2], activeLeafId: "removed" }] } } as unknown as SessionView;
		expect(displayedEntries(unknown).map(entry => entry.id)).toEqual(["a", "abandoned"]);
	});
});
