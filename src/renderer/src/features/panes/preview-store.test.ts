import { beforeEach, describe, expect, it } from "vitest";
import { OVERVIEW_DOCK } from "../../state/dockLayout";
import { NO_HISTORY, usePreview } from "./preview-store";

beforeEach(() => usePreview.setState({ byScope: {} }));

describe("Preview navigation per dock scope", () => {
	it("keeps URL and history separate for two chats in the same project", () => {
		const chats = [{ id: "chat-a", project: "/work/project" }, { id: "chat-b", project: "/work/project" }];
		const [a, b] = chats;
		if (!a || !b) throw new Error("Missing test chats");
		const preview = usePreview.getState();
		preview.go(a.id, "http://localhost:3000/a");
		preview.go(a.id, "http://localhost:3000/a-next");
		preview.go(b.id, "http://localhost:4000/b");
		preview.step(a.id, -1);
		preview.reload(a.id);
		expect(usePreview.getState().byScope[a.id]).toEqual({ entries: ["http://localhost:3000/a", "http://localhost:3000/a-next"], index: 0, nonce: 1 });
		expect(usePreview.getState().byScope[b.id]).toEqual({ entries: ["http://localhost:4000/b"], index: 0, nonce: 0 });
		expect(usePreview.getState().byScope[a.project]).toBeUndefined();
	});
	it("shares only the overview scope and leaves untouched chats empty", () => {
		usePreview.getState().go(OVERVIEW_DOCK, "https://example.com/overview");
		expect(usePreview.getState().byScope[OVERVIEW_DOCK]?.entries).toEqual(["https://example.com/overview"]);
		expect(usePreview.getState().byScope["chat-a"] ?? NO_HISTORY).toEqual({ entries: [], index: -1, nonce: 0 });
	});
	it("truncates forward history only within the scope being navigated", () => {
		const preview = usePreview.getState();
		preview.go("chat-a", "https://example.com/1");
		preview.go("chat-a", "https://example.com/2");
		preview.go("chat-b", "https://example.com/b");
		preview.step("chat-a", -1);
		preview.go("chat-a", "https://example.com/new");
		expect(usePreview.getState().byScope["chat-a"]?.entries).toEqual(["https://example.com/1", "https://example.com/new"]);
		expect(usePreview.getState().byScope["chat-b"]?.entries).toEqual(["https://example.com/b"]);
	});
});
