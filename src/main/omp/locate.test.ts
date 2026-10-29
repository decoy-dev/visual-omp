import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOmp } from "./cli";
import { ompPath, ompStatus } from "./locate";

const processState = vi.hoisted(() => ({
	version: "18.14.0",
	path: "/fixture/omp" as string | null,
	envPath: "",
	binaryVersions: {} as Record<string, string>,
	executed: [] as string[],
}));
vi.mock("node:child_process", () => ({
	execFile: (bin: string, _args: string[], options: { cwd?: string }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
		const executable = resolve(options.cwd ?? process.cwd(), bin);
		processState.executed.push(executable);
		const version = processState.binaryVersions[executable] ?? processState.version;
		callback(null, version ? `omp ${version}\n` : "No version available\n", "");
	},
}));
vi.mock("../env", () => ({ userEnv: async () => ({ PATH: processState.envPath }) }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ ompPath: processState.path }) }));

beforeEach(() => {
	processState.version = "18.14.0";
	processState.path = "/fixture/omp";
	processState.envPath = "";
	processState.binaryVersions = {};
	processState.executed = [];
});

const fixtureDirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(fixtureDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function binaries() {
	const root = await mkdtemp(join(tmpdir(), "vomp-executable-"));
	fixtureDirs.push(root);
	const appDir = join(root, "app");
	const projectDir = join(root, "project");
	const relativeBinDir = join("node_modules", ".bin");
	const name = process.platform === "win32" ? "omp.exe" : "omp";
	const appRelative = join(appDir, relativeBinDir, name);
	const projectRelative = join(projectDir, relativeBinDir, name);
	const absolute = join(appDir, "trusted-bin", name);
	for (const file of [appRelative, projectRelative, absolute]) {
		await mkdir(resolve(file, ".."), { recursive: true });
		await writeFile(file, "", { mode: 0o755 });
	}
	processState.binaryVersions = { [appRelative]: "18.14.0", [absolute]: "18.14.0", [projectRelative]: "18.13.3" };
	processState.version = "18.13.3";
	return { appDir, projectDir, relativeBinDir, name, appRelative, projectRelative, absolute };
}

describe("minimum omp version", () => {
	it.each(["18.4.0", "18.11.0", "18.13.3", "18.14.0-beta.1"])("refuses %s for normal commands while retaining the updater path", async version => {
		processState.version = version;
		const status = await ompStatus(true);
		expect(status).toMatchObject({ found: true, supported: false, version, minVersion: "18.14.0" });
		await expect(ompPath()).rejects.toThrow("visual-omp needs 18.14.0 or newer");
		await expect(ompPath({ allowUnsupported: true })).resolves.toBe(resolve("/fixture/omp"));
	});

	it.each(["18.14.0", "18.14.0+build.1", "18.14.1", "19.0.0"])("accepts %s", async version => {
		processState.version = version;
		expect(await ompStatus(true)).toMatchObject({ found: true, supported: true, problem: null });
		await expect(ompPath()).resolves.toBe(resolve("/fixture/omp"));
	});

	it("refreshes the detected version after an update", async () => {
		processState.version = "18.13.3";
		expect((await ompStatus(true)).supported).toBe(false);
		processState.version = "18.14.0";
		expect((await ompStatus()).supported).toBe(false);
		expect((await ompStatus(true)).supported).toBe(true);
		await expect(ompPath()).resolves.toBe(resolve("/fixture/omp"));
	});

	it.each([null, "/fixture/omp"])("never treats an unavailable binary as updatable (%s)", async path => {
		processState.path = path;
		processState.version = "";
		expect((await ompStatus(true)).found).toBe(false);
		await expect(ompPath({ allowUnsupported: true })).rejects.toThrow();
	});
});

describe("omp executable identity", () => {
	it("ignores relative PATH entries and runs the checked absolute binary from another project", async () => {
		const paths = await binaries();
		vi.spyOn(process, "cwd").mockReturnValue(paths.appDir);
		processState.path = null;
		processState.envPath = ["", ".", paths.relativeBinDir, resolve(paths.absolute, "..")].join(delimiter);
		const status = await ompStatus(true);
		expect(status).toMatchObject({ supported: true, path: paths.absolute });
		expect(isAbsolute(await ompPath())).toBe(true);

		const result = await runOmp(["--version"], { cwd: paths.projectDir });
		expect(result.stdout).toContain("18.14.0");
		expect(processState.executed).toEqual([paths.absolute, paths.absolute]);
		expect(processState.executed).not.toContain(paths.projectRelative);
	});

	it("resolves a relative override before checking it and retains that identity from another project", async () => {
		const paths = await binaries();
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(paths.appDir);
		processState.path = join(paths.relativeBinDir, paths.name);
		expect(await ompStatus(true)).toMatchObject({ supported: true, path: paths.appRelative });

		cwd.mockReturnValue(paths.projectDir);
		expect(await ompPath()).toBe(paths.appRelative);
		const result = await runOmp(["--version"], { cwd: paths.projectDir });
		expect(result.stdout).toContain("18.14.0");
		expect(processState.executed).toEqual([paths.appRelative, paths.appRelative]);
		expect(processState.executed).not.toContain(paths.projectRelative);
	});
});
