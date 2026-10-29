import { describe, expect, it, vi } from "vitest";
import { ghostSourceUnchanged, predictionSuffix, projectWord, WordFeedback } from "./predictions";

describe("word feedback", () => {
	const first = { folder: "/project", text: "test", cursor: 4, suffix: "ing" };
	it("reports one accepted suggestion once, without also rejecting it on cleanup", () => {
		const send = vi.fn();
		const feedback = new WordFeedback(send);
		feedback.show(first);
		feedback.show({ ...first });
		feedback.finish(true);
		feedback.finish(false);
		expect(send).toHaveBeenCalledExactlyOnceWith(first, true);
	});
	it("reports a suggestion typed past or replaced, and keeps the original folder and text", () => {
		const send = vi.fn();
		const feedback = new WordFeedback(send);
		feedback.show(first);
		feedback.show({ ...first, folder: "/other" });
		feedback.show(null);
		expect(send.mock.calls).toEqual([[first, false], [{ ...first, folder: "/other" }, false]]);
	});
	it("projects matching typing without treating it as rejected feedback", () => {
		const send = vi.fn();
		const feedback = new WordFeedback(send);
		feedback.show(first);
		const projected = projectWord(first, "/project", "testi", 5);
		expect(projected?.suffix).toBe("ng");
		feedback.show(projected, "testi");
		expect(send).not.toHaveBeenCalled();
		feedback.finish(true);
		expect(send).toHaveBeenCalledExactlyOnceWith(projected, true);
		expect(projectWord(first, "/project", "testr", 5)).toBeNull();
		expect(projectWord(first, "/other", "test", 4)).toBeNull();
	});
});

describe("captured prediction insertion guard", () => {
	const source = { draft: "Please", mode: null, hostId: "host", generation: 1 };
	it("inserts only into the unchanged native draft and original room", () => {
		expect(ghostSourceUnchanged(source, { ...source })).toBe(true);
		expect(ghostSourceUnchanged(source, { ...source, draft: "Please use my newer message" })).toBe(false);
		expect(ghostSourceUnchanged(source, { ...source, mode: "shell" })).toBe(false);
		expect(ghostSourceUnchanged(source, { ...source, generation: 2 })).toBe(false);
		expect(ghostSourceUnchanged(source, { ...source, hostId: "another" })).toBe(false);
	});
	it("shows only a matching displayed prediction prefix, never a different or multiline draft", () => {
		expect(predictionSuffix("Please check tests…", "Please")).toBe(" check tests…");
		expect(predictionSuffix("Please check tests…", "Different")).toBeNull();
		expect(predictionSuffix("Please check tests…", "Please\n")).toBeNull();
	});
});
