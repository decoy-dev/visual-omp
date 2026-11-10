import { describe, expect, it } from "vitest";
import { outputPathInFolder, outputPathKey, relativePath } from "./outputPaths";

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
	it("shortens a /var project against /private/var file identity only on macOS", () => {
		const project = "/var/folders/tour/chat";
		const file = "/private/var/folders/tour/chat/Large Media Files/Large video.mp4";
		expect(relativePath(project, file, null, "darwin")).toBe("Large Media Files/Large video.mp4");
		expect(relativePath("/private/var/folders/tour/chat", "/var/folders/tour/chat/notes.txt", null, "darwin")).toBe("notes.txt");
		for (const platform of ["linux", "win32", undefined]) expect(relativePath(project, file, null, platform)).toBe(file);
	});
	it("uses verified project identity while keeping spelling and boundary checks for other paths", () => {
		expect(relativePath("/opened/project", "/real/project/media/Large video.mp4", "/real/project", "linux")).toBe("media/Large video.mp4");
		expect(relativePath("/opened/project", "/opened/project/media/Large video.mp4", "/real/project", "linux")).toBe("media/Large video.mp4");
		expect(relativePath("/opened/project", "/real/project-other/media/Large video.mp4", "/real/project", "linux")).toBe("/real/project-other/media/Large video.mp4");
		expect(relativePath("/opened/project", "/elsewhere/Large video.mp4", "/real/project", "linux")).toBe("/elsewhere/Large video.mp4");
		expect(relativePath("C:\\Project", "C:\\Project\\media\\Large video.mp4", null, "win32")).toBe("media/Large video.mp4");
		expect(relativePath("C:\\Project", "D:\\Media\\Large video.mp4", null, "win32")).toBe("D:\\Media\\Large video.mp4");
	});
});
