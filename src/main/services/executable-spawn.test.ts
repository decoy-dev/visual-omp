import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectFiles } from "../files";
import { MissingBinaryError, run, runGh, runGit } from "../git/run";
import { startTerminal, killAllTerminals } from "../terminals";

const fake = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv, spawn: vi.fn(), execFile: vi.fn(), ptySpawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => fake.spawn(...args), execFile: (...args: unknown[]) => fake.execFile(...args) }));
vi.mock("node-pty", () => ({ spawn: (...args: unknown[]) => fake.ptySpawn(...args) }));
vi.mock("../env", () => ({ userEnv: async () => fake.env, ptyEnv: (env: NodeJS.ProcessEnv) => env }));
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));

let root: string;
let project: string;
let trusted: string;
const nativeName = (name: string) => process.platform === "win32" ? `${name}.exe` : name;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vomp-executable-spawn-"));
	project = join(root, "project");
	trusted = join(root, "trusted");
	for (const dir of [project, join(project, "bin"), trusted]) await mkdir(dir, { recursive: true });
	for (const name of ["git", "gh", "powershell", "shell"]) {
		for (const dir of [project, join(project, "bin"), trusted]) await writeFile(join(dir, nativeName(name)), "", { mode: 0o755 });
	}
	fake.env = { PATH: ["", ".", "bin", trusted].join(delimiter), SHELL: join(trusted, nativeName("shell")) };
	fake.spawn.mockReset();
	fake.execFile.mockReset();
	fake.ptySpawn.mockReset();
	fake.spawn.mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
		});
		queueMicrotask(() => { child.stdout.write("trusted output"); child.emit("close", 0, null); });
		return child;
	});
	fake.execFile.mockImplementation((_bin, _args, _options, callback) => callback(null, "a.txt\n", ""));
	fake.ptySpawn.mockReturnValue({ onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() });
});
afterEach(async () => {
	killAllTerminals();
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

describe("app-selected executable identity", () => {
	it("resolves git and gh before spawning in a hostile project cwd", async () => {
		vi.spyOn(process, "cwd").mockReturnValue(project);
		await runGit(["status"], { cwd: project });
		await runGh(["version"], { cwd: project });
		expect(fake.spawn.mock.calls.map(call => call[0])).toEqual([join(trusted, nativeName("git")), join(trusted, nativeName("gh"))]);
		for (const call of fake.spawn.mock.calls) expect(call[2].cwd).toBe(project);
	});

	it("rejects missing executables without letting spawn search empty or relative PATH entries", async () => {
		fake.env.PATH = ["", ".", "bin", ""].join(delimiter);
		vi.spyOn(process, "cwd").mockReturnValue(project);
		await expect(run("git", [], { cwd: project, env: fake.env })).rejects.toBeInstanceOf(MissingBinaryError);
		expect(fake.spawn).not.toHaveBeenCalled();
	});

	it("uses a validated explicit executable without resolving it against the child cwd", async () => {
		const executable = join(trusted, nativeName("git"));
		await run(executable, [], { cwd: project, env: {} });
		expect(fake.spawn.mock.calls[0]?.[0]).toBe(executable);
	});

	it("resolves the file picker's git and retains the walk fallback when no safe git is available", async () => {
		expect(await projectFiles(project)).toEqual(["a.txt"]);
		expect(fake.execFile.mock.calls[0]?.[0]).toBe(join(trusted, nativeName("git")));
		fake.execFile.mockClear();
		fake.env.PATH = ["", ".", "bin"].join(delimiter);
		await writeFile(join(project, "walked.txt"), "file");
		expect(await projectFiles(project)).toContain("walked.txt");
		expect(fake.execFile).not.toHaveBeenCalled();
	});

	it("resolves the terminal shell while preserving an explicitly requested shell command", async () => {
		const command = 'echo "$PATH"; ./requested-script';
		await startTerminal({ cwd: project, command });
		const call = fake.ptySpawn.mock.calls[0];
		expect(call?.[0]).toBe(join(trusted, nativeName(process.platform === "win32" ? "powershell" : "shell")));
		expect(call?.[1].at(-1)).toBe(command);
		expect(call?.[2].cwd).toBe(project);
	});

	it("does not start a terminal when only cwd-relative shells are available", async () => {
		fake.env.PATH = ["", ".", "bin"].join(delimiter);
		fake.env.SHELL = nativeName("shell");
		await expect(startTerminal({ cwd: project })).rejects.toMatchObject({ code: "ENOENT" });
		expect(fake.ptySpawn).not.toHaveBeenCalled();
	});
});
