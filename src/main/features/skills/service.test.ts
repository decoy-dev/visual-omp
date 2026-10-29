import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpRunner } from "../plugins/stream";
import { SkillService } from "./service";

const fake = vi.hoisted(() => ({
	dirs: new Set<string>(),
	files: new Map<string, string>(),
	stat: vi.fn(),
	read: vi.fn(),
	readdir: vi.fn(),
	write: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
	stat: (path: string) => fake.stat(path),
	readFile: (path: string) => fake.read(path),
	readdir: (path: string) => fake.readdir(path),
	realpath: async (path: string) => path,
	rm: vi.fn(),
}));
vi.mock("../../files", () => ({
	pathExists: async (path: string) => fake.dirs.has(path),
	writeText: (...args: unknown[]) => fake.write(...args),
}));
vi.mock("../../omp/paths", () => ({ agentDir: () => "test-user-agent" }));

const runner: OmpRunner = {
	env: vi.fn(async () => ({ HOME: homedir() })),
	run: vi.fn(async (argv: string[]) => ({
		code: 0,
		stdout: argv[0] === "config" ? "{}" : '{"skills":[],"warnings":[]}',
		stderr: "",
	})),
	stream: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
};
const service = new SkillService(runner, vi.fn(), vi.fn());
const ceilings = [...new Set([homedir(), tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/var/tmp"])])];
const manifest = JSON.stringify({ skills: { "@test/shared": "^1.0.0" } });

beforeEach(() => {
	vi.clearAllMocks();
	fake.dirs.clear();
	fake.files.clear();
	fake.stat.mockImplementation(async (path: string) => {
		if (!fake.dirs.has(path)) throw new Error("Missing test directory");
		return { isDirectory: () => true };
	});
	fake.read.mockImplementation(async (path: string) => {
		const text = fake.files.get(path);
		if (text === undefined) throw new Error("Missing test file");
		return text;
	});
	fake.readdir.mockResolvedValue([]);
	fake.write.mockResolvedValue(undefined);
});

describe("project skill discovery ceilings", () => {
	it.each(ceilings)("does not inspect project registries at %s", async cwd => {
		fake.dirs.add(join(cwd, ".omp"));
		fake.files.set(join(cwd, ".omp", "skills.json"), manifest);
		expect(await service.installed(cwd)).toEqual([]);
		expect(fake.stat).not.toHaveBeenCalled();
		expect(fake.read.mock.calls.map(([path]) => path)).toEqual([
			join("test-user-agent", "skills.json"), join("test-user-agent", "skills.lock.json"),
		]);
	});

	it.each(ceilings)("does not use %s or its ancestors as an anchor", async ceiling => {
		const cwd = join(ceiling, "project", "nested");
		fake.dirs.add(join(ceiling, ".omp"));
		fake.dirs.add(join(dirname(ceiling), ".omp"));
		fake.files.set(join(ceiling, ".omp", "skills.json"), manifest);
		expect(await service.installed(cwd)).toEqual([]);
		expect(fake.stat.mock.calls.map(([path]) => path)).toEqual([
			join(cwd, ".omp"), join(ceiling, "project", ".omp"),
		]);
		expect(fake.read).toHaveBeenCalledWith(join(resolve(cwd), ".omp", "skills.json"));
	});

	it("finds a nested project registry and retains the git-root fallback", async () => {
		const project = join(tmpdir(), "project");
		const cwd = join(project, "nested");
		const manifestPath = join(project, ".omp", "skills.json");
		fake.dirs.add(join(project, ".git"));
		fake.files.set(manifestPath, manifest);
		expect(await service.installed(cwd)).toMatchObject([{ id: "@test/shared", scope: "project", manifestPath }]);
		fake.dirs.add(join(cwd, ".omp"));
		fake.files.set(join(cwd, ".omp", "skills.json"), JSON.stringify({ skills: { "@test/local": "*" } }));
		expect(await service.installed(cwd)).toMatchObject([{ id: "@test/local", scope: "project" }]);
	});

	it.each(ceilings)("disables project installs and project diagnostics at %s", async cwd => {
		const listing = await service.list(cwd);
		expect(listing.projectScopeAvailable).toBe(false);
		expect(fake.readdir).not.toHaveBeenCalledWith(join(cwd, ".omp", "skills"));
		if (resolve(cwd) !== resolve(homedir())) expect(fake.readdir).not.toHaveBeenCalledWith(join(cwd, ".agents", "skills"));
		await expect(service.install({ cwd, global: false, specs: ["@test/pkg"] })).rejects.toThrow("Project skill installs are unavailable here in visual-omp.");
		expect(runner.stream).not.toHaveBeenCalled();
	});

	it("allows user installs at a ceiling and project installs in a subfolder", async () => {
		await service.install({ cwd: tmpdir(), global: true, specs: ["@test/pkg"] });
		expect(runner.stream).toHaveBeenCalledWith(["skill", "install", "@test/pkg", "-g"], expect.anything());
		const cwd = join(tmpdir(), "project");
		expect((await service.list(cwd)).projectScopeAvailable).toBe(true);
		await service.install({ cwd, global: false, specs: ["@test/pkg"] });
		expect(runner.stream).toHaveBeenLastCalledWith(["skill", "install", "@test/pkg"], expect.anything());
	});
});
