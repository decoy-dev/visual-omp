import { describe, expect, it } from "vitest";
import { isReplyWrite, replyWriteUndecided, toolContextReference, toolResultReplies } from "./friendly";

describe("out reply classification", () => {
	it("recognizes only write calls with a complete reply scheme", () => {
		expect(isReplyWrite("write", { path: "out://" })).toBe(true);
		expect(isReplyWrite("write", { file_path: "out://report" })).toBe(true);
		expect(isReplyWrite("write", { path: "out:/" })).toBe(false);
		expect(isReplyWrite("read", { path: "out://report" })).toBe(false);
	});

	it("defers a possible reply path only while its scheme is incomplete", () => {
		for (const path of ["", "o", "ou", "out", "out:", "out:/"]) expect(replyWriteUndecided("write", { path })).toBe(true);
		for (const path of ["out://", "output.md", "./out", "/tmp/out"]) expect(replyWriteUndecided("write", { path })).toBe(false);
		expect(replyWriteUndecided("bash", {})).toBe(false);
	});

	it("keeps reply order and excludes malformed or blank reply payloads", () => {
		expect(toolResultReplies({ replies: [null, "", " ", "First.", {}, "Second."] })).toEqual(["First.", "Second."]);
		expect(toolResultReplies({ replies: "First." })).toEqual([]);
		expect(toolResultReplies(undefined)).toEqual([]);
	});

	it("never offers file context actions for out destinations", () => {
		for (const name of ["write", "read", "edit"]) expect(toolContextReference({ name, args: { path: "out://report.md" }, running: false })).toEqual({});
		expect(toolContextReference({ name: "write", args: { path: "report.md" }, running: false })).toEqual({ path: "report.md" });
	});
});
