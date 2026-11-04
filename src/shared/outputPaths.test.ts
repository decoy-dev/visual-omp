import { describe, expect, it } from "vitest";
import { outputPathInFolder, outputPathKey } from "./outputPaths";

describe("output path identity", () => {
	it.each(["tmp", "var", "etc"])("compares only macOS /%s aliases, including the folder itself", folder => {
		for (const suffix of ["", "/work/frames.png"]) {
			expect(outputPathKey(`/private/${folder}${suffix}`, "darwin")).toBe(`/${folder}${suffix}`);
			for (const platform of ["linux", "win32", undefined]) expect(outputPathKey(`/private/${folder}${suffix}`, platform)).toBe(`/private/${folder}${suffix}`);
		}
	});
	it("does not change similar folder names or arbitrary private folders", () => {
		for (const path of ["/private/tmp-other/file", "/private/variable/file", "/private/etcetera/file", "/private/Users/file", "C:/private/tmp/file"]) expect(outputPathKey(path, "darwin")).toBe(path);
	});
	it("uses the chat folder's alias without rewriting unrelated folders", () => {
		expect(outputPathInFolder("/private/tmp/work/a.png", "/tmp/work", "darwin")).toBe("/tmp/work/a.png");
		expect(outputPathInFolder("/tmp/work/a.png", "/private/tmp/work", "darwin")).toBe("/private/tmp/work/a.png");
		expect(outputPathInFolder("/private/var/work/a.png", "/tmp/work", "darwin")).toBe("/private/var/work/a.png");
		expect(outputPathInFolder("/private/tmp/work/a.png", "/Users/me/work", "darwin")).toBe("/private/tmp/work/a.png");
		expect(outputPathInFolder("/private/tmp/work/a.png", "/tmp/work", "linux")).toBe("/private/tmp/work/a.png");
	});
});
