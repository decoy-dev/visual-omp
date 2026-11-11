import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAgent,
	customizeBundledAgent,
	deleteAgent,
	listAgents,
	readAgentFile,
	updateAgent,
	writeAgentRaw,
} from "./service";

const fake = vi.hoisted(() => ({
	env: {} as NodeJS.ProcessEnv,
	bundled: [] as string[],
	dirs: new Set<string>(),
	files: new Map<string, string>(),
	stat: vi.fn(),
	write: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
	stat: (path: string) => fake.stat(path),
	readdir: async (path: string) => [...fake.files.keys()]
		.filter(file => dirname(file) === path)
		.map(file => ({ name: basename(file), isFile: () => true, isSymbolicLink: () => false })),
	mkdtemp: async () => "unused-bundled-scratch",
	rm: vi.fn(),
	unlink: async (path: string) => { fake.files.delete(path); },
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
vi.mock("../../env", () => ({ userEnv: async () => fake.env }));
vi.mock("../../omp/config-file", () => ({ deleteConfigPath: vi.fn(), readConfig: vi.fn(), setConfigPath: vi.fn() }));
vi.mock("../../omp/cli", () => ({
	runOmpJson: async (argv: string[]) => {
		if (argv[0] === "agents") return { written: fake.bundled };
		return { value: argv[2] === "task.disabledAgents" ? [] : {} };
	},
}));

beforeEach(() => {
	fake.env = {};
	fake.bundled = [];
	fake.dirs.clear();
	fake.files.clear();
	fake.write.mockClear();
	fake.stat.mockReset().mockImplementation(async (path: string) => {
		if (!fake.dirs.has(path)) throw new Error("Missing test directory");
		return { isDirectory: () => true };
	});
});

afterEach(() => vi.unstubAllEnvs());

const draft = { name: "helper", description: "Helps", systemPrompt: "Help with the task." };
const ceilings = [...new Set([homedir(), tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/var/tmp"])])];

describe("user helper directory", () => {
	const custom = join(tmpdir(), "shell-agent");
	const root = join(homedir(), ".omp");

	it.each([
		{ name: "the default directory when unset", env: {}, dir: join(root, "agent") },
		{ name: "the login-shell override", env: { PI_CODING_AGENT_DIR: custom }, dir: custom },
		{
			name: "the named profile before the override",
			env: { PI_CODING_AGENT_DIR: custom, OMP_PROFILE: "work", PI_PROFILE: "ignored" },
			dir: join(root, "profiles", "work", "agent"),
		},
		{
			name: "the legacy profile before the override",
			env: { PI_CODING_AGENT_DIR: custom, PI_PROFILE: "work" },
			dir: join(root, "profiles", "work", "agent"),
		},
	])("lists and edits helpers under $name", async ({ env, dir }) => {
		vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
		fake.env = env;
		const agentsDir = join(dir, "agents");
		const filePath = join(agentsDir, "helper.md");
		expect((await listAgents(null, true)).dirs.user).toBe(agentsDir);

		const file = await createAgent(draft, "user");
		expect(file).toMatchObject({ filePath, scope: "user" });
		expect(fake.write).toHaveBeenLastCalledWith(filePath, file.content);
		expect((await listAgents()).agents).toMatchObject([{ name: "helper", filePath, scope: "user" }]);
		expect((await readAgentFile(filePath)).scope).toBe("user");
		expect((await updateAgent(filePath, { description: "Helps more" })).scope).toBe("user");
		expect((await writeAgentRaw(filePath, file.content)).scope).toBe("user");
		await deleteAgent(filePath);
		expect(fake.files.has(filePath)).toBe(false);

		const bundledPath = join(tmpdir(), "bundled-helper.md");
		fake.files.set(bundledPath, file.content);
		fake.bundled = [bundledPath];
		await listAgents(null, true);
		expect(await customizeBundledAgent("helper", "user")).toMatchObject({ filePath, scope: "user" });
		expect(fake.write).toHaveBeenLastCalledWith(filePath, file.content);
	});
});

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
