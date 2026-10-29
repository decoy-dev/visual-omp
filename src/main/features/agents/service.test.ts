import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgent, listAgents, readAgentFile, updateAgent } from "./service";

const fake = vi.hoisted(() => ({
	dirs: new Set<string>(),
	files: new Map<string, string>(),
	stat: vi.fn(),
	write: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
	stat: (path: string) => fake.stat(path),
	readdir: async () => [],
	mkdtemp: async () => "unused-bundled-scratch",
	rm: vi.fn(),
	unlink: vi.fn(),
}));
vi.mock("../../files", () => ({
	pathExists: async (path: string) => fake.files.has(path),
	readText: async (path: string) => {
		const text = fake.files.get(path);
		if (text === undefined) throw new Error("Missing test file");
		return text;
	},
	writeText: async (path: string, content: string) => {
		fake.write(path, content);
		fake.files.set(path, content);
	},
}));
vi.mock("../../omp/paths", () => ({ agentDir: () => "test-user-agent" }));
vi.mock("../../omp/config-file", () => ({ deleteConfigPath: vi.fn(), readConfig: vi.fn(), setConfigPath: vi.fn() }));
vi.mock("../../omp/cli", () => ({
	runOmpJson: async (argv: string[]) => {
		if (argv[0] === "agents") return { written: [] };
		return { value: argv[2] === "task.disabledAgents" ? [] : {} };
	},
}));

beforeEach(() => {
	fake.dirs.clear();
	fake.files.clear();
	fake.write.mockClear();
	fake.stat.mockReset().mockImplementation(async (path: string) => {
		if (!fake.dirs.has(path)) throw new Error("Missing test directory");
		return { isDirectory: () => true };
	});
});

const draft = { name: "helper", description: "Helps", systemPrompt: "Help with the task." };
const ceilings = [...new Set([homedir(), tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/var/tmp"])])];

describe("project helper discovery ceilings", () => {
	it.each(ceilings)("does not inspect or create project helpers at %s", async cwd => {
		fake.dirs.add(join(cwd, ".omp", "agents"));
		const listing = await listAgents(cwd);
		expect(listing.dirs).toMatchObject({ project: null, projectDefault: null });
		expect(fake.stat).not.toHaveBeenCalled();
		await expect(createAgent(draft, "project", cwd)).rejects.toThrow("Project helpers are unavailable here in visual-omp.");
		expect(fake.write).not.toHaveBeenCalled();
	});

	it.each(ceilings)("stops before %s and its ancestors for a nested chat", async ceiling => {
		const cwd = join(ceiling, "project", "nested");
		fake.dirs.add(join(ceiling, ".omp", "agents"));
		fake.dirs.add(join(dirname(ceiling), ".omp", "agents"));
		const listing = await listAgents(cwd);
		expect(listing.dirs).toMatchObject({ project: null, projectDefault: join(resolve(cwd), ".omp", "agents") });
		expect(fake.stat.mock.calls.map(([path]) => path)).toEqual([
			join(cwd, ".omp", "agents"),
			join(ceiling, "project", ".omp", "agents"),
		]);
	});

	it("reads the nearest project directory below a temporary root and creates there", async () => {
		const project = join(tmpdir(), "project");
		const cwd = join(project, "nested");
		const dir = join(project, ".omp", "agents");
		fake.dirs.add(dir);
		expect((await listAgents(cwd)).dirs.project).toBe(dir);
		const file = await createAgent({ ...draft, structured: true, output: { type: "string" }, tools: [] }, "project", cwd);
		expect(file.filePath).toBe(join(dir, "helper.md"));
		expect(file.validation).toMatchObject({ ok: true, fields: { structured: true, output: { type: "string" }, tools: [] } });
		await updateAgent(file.filePath, { description: "Helps more" });
		expect((await readAgentFile(file.filePath)).validation).toMatchObject({
			ok: true, fields: { description: "Helps more", structured: true, output: { type: "string" }, tools: [] },
		});
	});

	it("still permits user helpers when the chat folder is a ceiling", async () => {
		expect((await createAgent(draft, "user", tmpdir())).scope).toBe("user");
		expect(fake.write).toHaveBeenCalledTimes(1);
	});
});
