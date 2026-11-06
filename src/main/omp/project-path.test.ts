import { afterEach, describe, expect, it, vi } from "vitest";
import { projectPath } from "./project-path";

const fake = vi.hoisted(() => ({ realpath: vi.fn() }));
vi.mock("node:fs", () => ({ realpathSync: fake.realpath }));
afterEach(() => { vi.unstubAllGlobals(); fake.realpath.mockReset(); });
const platform = (value: NodeJS.Platform) => vi.stubGlobal("process", new Proxy(process, { get: (target, key) => key === "platform" ? value : Reflect.get(target, key) }));

describe("omp project cwd spelling", () => {
	it("strips macOS /private/tmp only when both paths resolve to the same folder", () => {
		platform("darwin");
		fake.realpath.mockImplementation((path: string) => path === "/tmp/project" ? "/private/tmp/project" : path);
		expect(projectPath("/private/tmp/project")).toBe("/tmp/project");
		fake.realpath.mockImplementation((path: string) => path);
		expect(projectPath("/private/tmp/project")).toBe("/private/tmp/project");
	});
	it("resolves a symlinked parent before applying the macOS /private/var rule", () => {
		platform("darwin");
		fake.realpath.mockImplementation((path: string) => ["/Users/person/Projects/app", "/var/project"].includes(path) ? "/private/var/project" : path);
		expect(projectPath("/Users/person/Projects/app")).toBe("/var/project");
	});
	it("resolves POSIX folder aliases without stripping /private on Linux", () => {
		platform("linux");
		fake.realpath.mockReturnValue("/private/work/project");
		expect(projectPath("/home/person/Projects/app")).toBe("/private/work/project");
	});
	it("keeps missing paths unchanged and preserves /private when its alternate spelling is missing", () => {
		platform("darwin");
		fake.realpath.mockImplementation(() => { throw Object.assign(new Error("Missing folder"), { code: "ENOENT" }); });
		expect(projectPath("/missing/project")).toBe("/missing/project");
		fake.realpath.mockImplementation((path: string) => { if (path === "/tmp/project") throw new Error("Missing alternate"); return path; });
		expect(projectPath("/private/tmp/project")).toBe("/private/tmp/project");
	});
	it("keeps Windows casing, symlink and short-name spelling without a POSIX realpath call", () => {
		platform("win32");
		for (const path of ["C:\\Users\\person\\Projects\\app", "C:\\PROGRA~1\\app", "c:\\Alias\\App"]) expect(projectPath(path)).toBe(path);
		expect(fake.realpath).not.toHaveBeenCalled();
	});
});
