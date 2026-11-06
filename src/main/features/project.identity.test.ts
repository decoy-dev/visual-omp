import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectSummary } from "@shared/ipc";
import type { ProjectCreateResult } from "@shared/contracts/project";

const fake = vi.hoisted(() => ({
	root: "", handlers: new Map<string, (...args: unknown[]) => unknown>(),
	prefs: { extraProjects: [] as string[], pinnedProjects: [] as string[], projectColors: {} }, recent: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => fake.root, addRecentDocument: fake.recent } }));
vi.mock("../ipc", () => ({ handle: (name: string, handler: (...args: unknown[]) => unknown) => fake.handlers.set(name, handler) }));
vi.mock("../prefs", () => ({ getPrefs: () => fake.prefs, setPrefs: (patch: object) => Object.assign(fake.prefs, patch) }));
vi.mock("../omp/sessions", () => ({ listProjects: async () => fake.prefs.extraProjects.map(path => ({ path, name: "project", sessionCount: 0, lastActivity: 0, exists: true })) }));
vi.mock("../omp/cli", () => ({ runOmpJson: vi.fn() }));

beforeEach(async () => {
	fake.root = await mkdtemp(join(tmpdir(), "vomp-project-identity-"));
	fake.prefs = { extraProjects: [], pinnedProjects: [], projectColors: {} };
	fake.handlers.clear(); fake.recent.mockClear(); vi.resetModules();
	// The feature captures userData at module initialization, after this test's scratch profile exists.
	(await import("./project")).register();
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(fake.root, { recursive: true, force: true }); });

it("registers aliases once and returns the same cwd to folder picker, drag and Home callers", async () => {
	const target = join(fake.root, "projects");
	const alias = join(fake.root, "Projects-alias");
	await mkdir(target); await mkdir(join(target, "app"));
	await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
	// Exercise the POSIX cwd rule on Windows CI without needing symlink privileges beyond a junction.
	vi.stubGlobal("process", new Proxy(process, { get: (source, key) => key === "platform" ? "linux" : Reflect.get(source, key) }));
	// Expect what projectPath computes: on Windows, fs.realpathSync keeps 8.3 short names (RUNNER~1) that the
	// native fs.promises.realpath expands.
	const canonical = realpathSync(join(target, "app"));
	const add = fake.handlers.get("project:add")!;
	expect((await add(join(alias, "app")) as ProjectSummary).path).toBe(canonical);
	expect((await add(join(target, "app")) as ProjectSummary).path).toBe(canonical);
	expect(fake.prefs.extraProjects).toEqual([canonical]);
	expect(fake.recent).toHaveBeenLastCalledWith(canonical);
	expect(JSON.parse(await readFile(join(fake.root, "recent-folders.json"), "utf8"))).toMatchObject([{ path: canonical }]);
	expect(fake.handlers.get("project:paths")!([join(alias, "app"), join(fake.root, "missing")])).toEqual([canonical, join(fake.root, "missing")]);
	const created = await fake.handlers.get("project:create")!({ name: "new", parentDir: alias }) as ProjectCreateResult;
	expect(created).toEqual({ ok: true, path: realpathSync(join(target, "new")) });
	if (!created.ok) throw new Error("Project creation failed");
	await fake.handlers.get("project:remove")!(join(alias, "app"));
	expect(fake.prefs.extraProjects).toEqual([created.path]);
});
