import type * as FsPromisesModule from "node:fs/promises";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireExecutable, resolveExecutable } from "./executable";

const windows = vi.hoisted(() => ({
	active: false,
	files: new Map<string, "file" | "directory" | "denied">(),
	probes: [] as string[],
}));
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof FsPromisesModule>();
	return {
		...actual,
		stat: async (...args: Parameters<typeof FsPromisesModule.stat>) => {
			if (!windows.active) return actual.stat(...args);
			const file = String(args[0]);
			windows.probes.push(file);
			const kind = windows.files.get(file.toLowerCase());
			if (!kind) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return { isFile: () => kind !== "directory" };
		},
		access: async (...args: Parameters<typeof FsPromisesModule.access>) => {
			if (!windows.active) return actual.access(...args);
			if (windows.files.get(String(args[0]).toLowerCase()) === "denied") throw new Error("denied");
		},
	};
});

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vomp-executable-"));
	windows.active = false;
	windows.files.clear();
	windows.probes = [];
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

async function fixture(relative: string, mode = 0o755): Promise<string> {
	const file = join(root, relative);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, "", { mode });
	return file;
}

describe.skipIf(process.platform === "win32")("POSIX executable selection", () => {
	it("ignores empty and relative PATH entries even when the app cwd contains executables", async () => {
		await fixture("project/git");
		await fixture("project/bin/git");
		const trusted = await fixture("trusted/git");
		vi.spyOn(process, "cwd").mockReturnValue(join(root, "project"));
		expect(await resolveExecutable("git", { PATH: `:.:bin:${dirname(trusted)}` }, "linux")).toBe(trusted);
		expect(await resolveExecutable("git", { PATH: ":.:bin:" }, "linux")).toBeNull();
	});

	it("requires a regular file with execute permission and preserves symlinked installations", async () => {
		await mkdir(join(root, "directory/git"), { recursive: true });
		await fixture("unexecutable/git", 0o644);
		const trusted = await fixture("trusted/git");
		await mkdir(join(root, "links"));
		await symlink(trusted, join(root, "links/git"));
		const PATH = ["directory", "unexecutable", "links"].map(dir => join(root, dir)).join(":");
		expect(await resolveExecutable("git", { PATH }, "linux")).toBe(join(root, "links/git"));
	});

	it("accepts absolute explicit executables and refuses cwd-relative explicit paths", async () => {
		const executable = await fixture("bin/git");
		expect(await resolveExecutable(executable, {}, "linux")).toBe(executable);
		expect(await resolveExecutable("./bin/git", { PATH: dirname(executable) }, "linux")).toBeNull();
		await expect(requireExecutable(join(root, "missing"), {})).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("uses the case-sensitive POSIX PATH variable", async () => {
		const executable = await fixture("bin/git");
		expect(await resolveExecutable("git", { Path: dirname(executable) }, "linux")).toBeNull();
	});
});

describe("Windows executable selection on every host", () => {
	beforeEach(() => { windows.active = true; });

	it("ignores cwd, drive-relative and root-relative entries and honors quoted absolute PATH", async () => {
		windows.files.set("c:\\tools bin\\git.exe", "file");
		const env = { Path: ';.;bin;C:bin;\\bin;"C:\\Tools Bin"', Pathext: ".CMD;.EXE;.COM" };
		expect(await resolveExecutable("git", env, "win32")).toBe("C:\\Tools Bin\\git.exe");
		expect(windows.probes.every(path => path.startsWith("C:\\Tools Bin\\"))).toBe(true);
		expect(windows.probes.some(path => path.toLowerCase().endsWith(".cmd"))).toBe(false);
	});

	it("uses native suffix ordering and never lets a batch launcher hide an executable", async () => {
		windows.files.set("c:\\bin\\git.cmd", "file");
		windows.files.set("c:\\bin\\git.exe", "file");
		windows.files.set("c:\\bin\\git.com", "file");
		expect(await resolveExecutable("git", { PATH: "C:\\bin", PATHEXT: ".CMD;.COM;.EXE" }, "win32")).toBe("C:\\bin\\git.com");
		expect(await resolveExecutable("git.exe", { PATH: "C:\\bin" }, "win32")).toBe("C:\\bin\\git.exe");
	});

	it("supports UNC directories, extensionless native files and absolute explicit paths", async () => {
		windows.files.set("\\\\server\\share\\tools\\omp", "file");
		expect(await resolveExecutable("omp", { PATH: "\\\\server\\share\\tools" }, "win32")).toBe("\\\\server\\share\\tools\\omp");
		windows.files.set("d:\\tools\\git.exe", "file");
		expect(await resolveExecutable("D:\\tools\\git.exe", {}, "win32")).toBe("D:\\tools\\git.exe");
		for (const command of ["D:git.exe", "\\tools\\git.exe", ".\\git.exe", "tools/git.exe"]) {
			expect(await resolveExecutable(command, { PATH: "D:\\tools" }, "win32")).toBeNull();
		}
	});

	it("skips directories and inaccessible candidates without reverting to an OS search", async () => {
		windows.files.set("c:\\directory\\git.exe", "directory");
		windows.files.set("c:\\denied\\git.exe", "denied");
		expect(await resolveExecutable("git.exe", { PATH: "C:\\directory;C:\\denied;.;" }, "win32")).toBeNull();
		expect(windows.probes).toEqual(["C:\\directory\\git.exe", "C:\\denied\\git.exe"]);
	});

	it("uses native defaults when PATHEXT contains shell scripts or malformed suffixes", async () => {
		windows.files.set("c:\\bin\\git.exe", "file");
		expect(await resolveExecutable("git", { PATH: "C:\\bin", PATHEXT: ".CMD;\\evil.exe;..\\git.exe" }, "win32")).toBe("C:\\bin\\git.exe");
	});
});
