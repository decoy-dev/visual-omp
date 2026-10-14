import { describe, expect, it } from "vitest";
import { CLOSED_LIMIT, type ClosedChat, pushClosed, takeReopenable } from "./closedChats";

const closed = (file: string, draft = ""): ClosedChat => ({ projectPath: "p", sessionFile: file, title: file, draft });

describe("pushClosed", () => {
	it("keeps the newest first, one entry per file, up to the limit", () => {
		let stack: ClosedChat[] = [];
		for (let index = 0; index < CLOSED_LIMIT + 2; index++) stack = pushClosed(stack, closed(`f${index}`));
		stack = pushClosed(stack, closed("f5", "draft"));
		expect(stack).toHaveLength(CLOSED_LIMIT);
		expect(stack[0]).toEqual(closed("f5", "draft"));
		expect(stack.filter(entry => entry.sessionFile === "f5")).toHaveLength(1);
		expect(stack.some(entry => entry.sessionFile === "f0")).toBe(false);
	});
});

describe("takeReopenable", () => {
	it("returns the newest chat that is closed and still on disk, listing the ones it passed over", async () => {
		const stack = [closed("open"), closed("gone"), closed("ok"), closed("older")];
		const result = await takeReopenable(
			stack,
			file => file === "open",
			async file => file !== "gone",
		);
		expect(result.chat?.sessionFile).toBe("ok");
		expect(result.skipped.map(entry => entry.sessionFile)).toEqual(["open", "gone"]);
	});

	it("returns nothing when no entry can come back", async () => {
		const result = await takeReopenable([closed("gone")], () => false, async () => false);
		expect(result).toEqual({ chat: null, skipped: [closed("gone")] });
	});
});
