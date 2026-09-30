import { describe, expect, it } from "vitest";
import { filterByName, pathSegments, tildePath, typedPath } from "./paths";

describe("pathSegments", () => {
	it("splits a POSIX path into clickable ancestors, root first", () => {
		expect(pathSegments("/Users/me/visual-omp", false)).toEqual([
			{ name: "/", path: "/" },
			{ name: "Users", path: "/Users" },
			{ name: "me", path: "/Users/me" },
			{ name: "visual-omp", path: "/Users/me/visual-omp" },
		]);
		expect(pathSegments("/", false)).toEqual([{ name: "/", path: "/" }]);
	});

	it("keeps the drive as the Windows root and accepts forward slashes", () => {
		expect(pathSegments("C:\\Users\\me", true)).toEqual([
			{ name: "C:", path: "C:\\" },
			{ name: "Users", path: "C:\\Users" },
			{ name: "me", path: "C:\\Users\\me" },
		]);
		expect(pathSegments("D:/code", true)).toEqual([
			{ name: "D:", path: "D:\\" },
			{ name: "code", path: "D:\\code" },
		]);
		expect(pathSegments("C:\\", true)).toEqual([{ name: "C:", path: "C:\\" }]);
	});

	it("treats a UNC server and share as one root", () => {
		expect(pathSegments("\\\\nas\\team\\site", true)).toEqual([
			{ name: "\\\\nas\\team", path: "\\\\nas\\team\\" },
			{ name: "site", path: "\\\\nas\\team\\site" },
		]);
	});
});

describe("typedPath", () => {
	it("expands ~ and recognizes absolute paths", () => {
		expect(typedPath("~", "/Users/me", false)).toBe("/Users/me");
		expect(typedPath(" ~/code ", "/Users/me", false)).toBe("/Users/me/code");
		expect(typedPath("/tmp", "/Users/me", false)).toBe("/tmp");
		expect(typedPath("C:\\code", "C:\\Users\\me", true)).toBe("C:\\code");
		expect(typedPath("~\\code", "C:\\Users\\me", true)).toBe("C:\\Users\\me\\code");
	});

	it("leaves plain filter text alone", () => {
		expect(typedPath("visual", "/Users/me", false)).toBeNull();
		expect(typedPath("C:\\code", "/Users/me", false)).toBeNull();
		expect(typedPath("/tmp", "C:\\Users\\me", true)).toBeNull();
		// Drive-relative (`C:foo`, `C:`) resolves against that drive's working folder, so it is not a location.
		expect(typedPath("C:foo", "C:\\Users\\me", true)).toBeNull();
		expect(typedPath("C:", "C:\\Users\\me", true)).toBeNull();
		expect(typedPath("D:/code", "C:\\Users\\me", true)).toBe("D:/code");
	});
});

describe("filterByName", () => {
	const items = [{ name: "omp-docs" }, { name: "visual-omp" }, { name: "Omnibus" }, { name: "notes" }];

	it("ranks prefix matches before substring matches, case-insensitively", () => {
		expect(filterByName(items, "om").map(item => item.name)).toEqual(["omp-docs", "Omnibus", "visual-omp"]);
	});

	it("returns everything for a blank query", () => {
		expect(filterByName(items, "  ")).toHaveLength(4);
	});
});

describe("tildePath", () => {
	it("abbreviates the home folder only at a segment boundary", () => {
		expect(tildePath("/Users/me/code", "/Users/me")).toBe("~/code");
		expect(tildePath("/Users/me", "/Users/me")).toBe("~");
		expect(tildePath("/Users/meg", "/Users/me")).toBe("/Users/meg");
	});
});
