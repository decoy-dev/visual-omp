import { describe, expect, it } from "vitest";
import { contextActionIds, contextPath, localPreviewUrl, projectRelativePath } from "./contextTargets";
import { toolContextReference } from "../chat/friendly";

const project = "/work/project";
const scope = { cwd: project, home: "/home/user" };

describe("context paths", () => {
	it("resolves relative and home paths and removes read selectors", () => {
		expect(contextPath("src/../notes.md:12-18", scope, "tool")).toBe("/work/project/notes.md");
		expect(contextPath("~/image.png:img", scope, "tool")).toBe("/home/user/image.png");
		expect(contextPath("../outside.txt", scope, "tool")).toBe("/work/outside.txt");
		expect(contextPath("/", scope)).toBe("/");
	});
	it("handles Windows drives and UNC roots independently of the test host", () => {
		expect(contextPath("C:\\work\\app\\..\\file.ts", scope, "tool")).toBe("C:\\work\\file.ts");
		expect(contextPath("\\\\server\\share\\app\\..\\file.ts", scope, "tool")).toBe("\\\\server\\share\\file.ts");
		expect(projectRelativePath("C:\\Work\\App", "c:\\work\\app\\src\\file.ts")).toBe("src/file.ts");
		expect(projectRelativePath("\\\\server\\share", "\\\\server\\share\\file.ts")).toBe("file.ts");
	});
	it("never offers a relative path outside the project", () => {
		expect(projectRelativePath(project, `${project}/src/file.ts`)).toBe("src/file.ts");
		expect(projectRelativePath(project, project)).toBe(".");
		expect(projectRelativePath(project, `${project}/../secret`)).toBeNull();
		expect(projectRelativePath(project, `${project}-other/file.ts`)).toBeNull();
		expect(projectRelativePath("/", "/file.ts")).toBe("file.ts");
		expect(projectRelativePath(null, "/file.ts")).toBeNull();
	});
	it("rejects unresolved names, internal addresses, URLs and globs", () => {
		for (const path of ["https://example.com/a.png", "local://notes.md", "artifact://abcd", "data:image/png;base64,AA==", "src/*.ts", "a\0b"]) expect(contextPath(path, scope, "tool")).toBeNull();
		expect(contextPath("file.ts", { cwd: null, home: null }, "tool")).toBeNull();
		expect(contextPath("~/file.ts", { cwd: project, home: null }, "tool")).toBeNull();
	});
	it("preserves known filesystem names rather than treating their punctuation as tool syntax", () => {
		for (const name of ["report:12", "question?.txt", "star*.txt", "trailing "]) {
			const path = `${project}/${name}`;
			expect(contextPath(path, scope)).toBe(path);
			expect(projectRelativePath(project, path)).toBe(name);
			expect(contextActionIds({ kind: "file", path }, project)).toContain("copyRelative");
		}
		expect(contextPath("/work/report:12", scope)).toBe("/work/report:12");
		expect(contextPath("report:12", scope)).toBe("/work/project/report:12");
		expect(contextPath("/work/report:12", scope, "tool")).toBe("/work/report");
		expect(contextPath("/work/a/../report:12", scope)).toBe("/work/a/../report:12");
	});
});

describe("context menu item sets", () => {
	it("limits Preview to loopback web URLs and a known project", () => {
		for (const url of ["http://localhost:5173/a", "https://127.0.0.1:3000/"]) expect(localPreviewUrl(url)).toBe(true);
		for (const url of ["http://[::1]:8080", "https://localhost.example.com", "http://127.0.0.1.evil.test", "file://localhost/a", "mailto:test@example.com", "http://localhost@evil.test", "invalid"]) expect(localPreviewUrl(url)).toBe(false);
		expect(contextActionIds({ kind: "link", url: "https://example.com" }, project)).toEqual(["openBrowser", "copyLink"]);
		expect(contextActionIds({ kind: "link", url: "http://localhost:5173" }, project)).toEqual(["openBrowser", "openPreview", "copyLink"]);
		expect(contextActionIds({ kind: "link", url: "http://localhost:5173" }, null)).toEqual(["openBrowser", "copyLink"]);
	});
	it("gives files absolute and relative path actions in a stable order", () => {
		expect(contextActionIds({ kind: "file", path: `${project}/src/a.ts` }, project)).toEqual(["open", "openDefault", "reveal", "copyPath", "copyRelative", "mention"]);
		expect(contextActionIds({ kind: "file", path: "/other/a.ts", changes: true }, project)).toEqual(["open", "changes", "openDefault", "reveal", "copyPath", "mention"]);
	});
	it("omits default-app actions for folders", () => {
		expect(contextActionIds({ kind: "folder", path: project }, project)).toEqual(["open", "reveal", "copyPath", "copyRelative", "mention"]);
	});
	it("separates inline-image actions from backing-file actions", () => {
		expect(contextActionIds({ kind: "image", source: "data:image/png;base64,AA==" }, project)).toEqual(["copyImage", "saveImage"]);
		expect(contextActionIds({ kind: "image", source: "", path: `${project}/image.png` }, project)).toEqual(["copyImage", "saveImage", "openDefault", "reveal", "copyPath"]);
	});
});

describe("tool row context references", () => {
	it("keeps full paths and URLs behind shortened summaries", () => {
		expect(toolContextReference({ name: "read", args: { path: "/work/project/source.ts:10-30" }, running: false })).toEqual({ path: "/work/project/source.ts:10-30" });
		expect(toolContextReference({ name: "read", args: { path: "https://example.com/doc" }, running: false })).toEqual({ url: "https://example.com/doc" });
		expect(toolContextReference({ name: "write", args: { path: "src/app.ts" }, running: true })).toEqual({ path: "src/app.ts" });
	});
	it("offers a one-file edit target without guessing a file for a multi-file summary", () => {
		expect(toolContextReference({ name: "edit", args: { input: "[src/app.ts#ABCD]\nPUT 1.=1:\n+x" }, running: false })).toEqual({ path: "src/app.ts" });
		expect(toolContextReference({ name: "edit", args: { input: "[a.ts#ABCD]\nPUT 1.=1:\n+x\n[b.ts#ABCD]\nPUT 1.=1:\n+y" }, running: false })).toEqual({});
		expect(toolContextReference({ name: "bash", args: { command: "echo hello" }, running: false })).toEqual({});
	});
});
