import { describe, expect, it } from "vitest";
import { fileMentions, formatFileMention } from "./fileMentions";

describe("formatFileMention", () => {
	it.each([
		["src/app.ts", "@src/app.ts"],
		["/tmp/Claude Design projects.zip", '@"/tmp/Claude Design projects.zip"'],
		["/tmp/tab\tname.pdf", '@"/tmp/tab\tname.pdf"'],
		['/tmp/My "design".pdf', '@\'/tmp/My "design".pdf\''],
		['/tmp/design".pdf', '@\'/tmp/design".pdf\''],
		["C:\\Users\\Jules\\My Files\\a.pdf", '@"C:\\Users\\Jules\\My Files\\a.pdf"'],
	])("formats %s for omp", (path, expected) => {
		expect(formatFileMention(path)).toBe(expected);
		expect(fileMentions(expected).map(mention => mention.path)).toEqual([path]);
	});

	it("leaves only directory completions open, including Windows directories", () => {
		expect(formatFileMention("My Files/", { isDirectory: true })).toBe('@"My Files/');
		expect(formatFileMention("C:\\My Files\\", { isDirectory: true })).toBe('@"C:\\My Files\\');
		expect(formatFileMention("src/", { isDirectory: true, isQuotedPrefix: true })).toBe('@"src/');
		expect(formatFileMention("src/", { isDirectory: true })).toBe("@src/");
		expect(formatFileMention("My Files/")).toBe('@"My Files/"');
	});

	it("preserves a whitespace path containing both quote types as plain text", () => {
		const path = '/tmp/Jules\' "design".pdf';
		expect(formatFileMention(path)).toBe(path);
		expect(fileMentions(formatFileMention(path))).toEqual([]);
	});
});
