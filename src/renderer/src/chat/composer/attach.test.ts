import { afterEach, describe, expect, it, vi } from "vitest";
import { attachPaths, mentionFor } from "./attach";
import { useComposerDrafts } from "./drafts";

afterEach(() => vi.restoreAllMocks());

describe("mentionFor", () => {
	it("quotes relative and absolute paths without changing project boundaries", () => {
		expect(mentionFor("/repo/My Files/a.pdf", "/repo/")).toBe('@"My Files/a.pdf"');
		expect(mentionFor("/other/My Files/a.pdf", "/repo")).toBe('@"/other/My Files/a.pdf"');
		expect(mentionFor("/repo-sibling/a.pdf", "/repo")).toBe("@/repo-sibling/a.pdf");
		expect(mentionFor("/tmp/Claude Design projects.zip", null)).toBe('@"/tmp/Claude Design projects.zip"');
		expect(mentionFor('C:\\Users\\Jules\\My Files\\a.pdf', 'C:\\Users\\Jules')).toBe('@"My Files\\a.pdf"');
		expect(mentionFor('C:\\Users\\Jules\\My Files\\a.pdf', null)).toBe('@"C:\\Users\\Jules\\My Files\\a.pdf"');
		expect(mentionFor("/repo/My Files/", "/repo")).toBe('@"My Files/"');
	});
});

it("inserts dropped and picked non-image files as complete mentions", () => {
	const store = useComposerDrafts.getState();
	const insert = vi.spyOn(store, "insert").mockImplementation(() => {});
	attachPaths("chat", null, ["/tmp/Claude Design projects.zip", '/tmp/My "design".pdf']);
	expect(insert).toHaveBeenCalledWith("chat", '@"/tmp/Claude Design projects.zip" @\'/tmp/My "design".pdf\' ');
});
