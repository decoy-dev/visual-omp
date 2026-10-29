import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController } from "../../state/session";
import { loadTree } from "./navigate";
vi.mock("../../state/app", () => ({ controllerFor: vi.fn(), useApp: {} }));
vi.mock("../../chat/composer/drafts", () => ({ useComposerDrafts: {} }));
vi.mock("./drive", () => ({ OmpBusyError: class extends Error {}, press: vi.fn(), readScreen: vi.fn(), readyEditor: vi.fn(), sleep: vi.fn(), waitForScreen: vi.fn() }));
const invoke = vi.fn();
beforeEach(() => {
	invoke.mockReset().mockImplementation(async (channel: string, file: string) => {
		if (channel === "sessions:resolve") return "/project/sibling.jsonl";
		const ids = file === "/project/sibling.jsonl" ? ["shared", "sibling-only"] : ["shared"];
		return ids.map(id => JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-29T12:00:00.000Z", message: { role: "user", content: id } })).join("\n");
	});
	vi.stubGlobal("window", { vomp: { invoke } });
});
describe("loadTree physical identity", () => {
	it("keeps a live predecessor's tree separate from a newer sibling", async () => {
		const session = { sessionFile: "/project/original.jsonl", getSnapshot: () => ({ host: { phase: "live" }, displayLeaf: null }) } as unknown as SessionController;
		const tree = await loadTree(session);
		expect(tree.entries.has("shared")).toBe(true);
		expect(tree.entries.has("sibling-only")).toBe(false);
		expect(invoke).not.toHaveBeenCalledWith("sessions:resolve", expect.anything());
	});
	it("resolves a saved view to the linked sibling", async () => {
		const session = { sessionFile: "/project/original.jsonl", getSnapshot: () => ({ host: null, displayLeaf: null }) } as unknown as SessionController;
		expect((await loadTree(session)).entries.has("sibling-only")).toBe(true);
	});
});
