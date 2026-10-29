import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInstructions } from "@shared/contracts/project";
import { register } from "./project";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	extra: ["AGENTS.local.md"],
	write: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/visual-omp-project-instruction-test" } }));
vi.mock("../ipc", () => ({ handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => fake.handlers.set(name, handler) }));
vi.mock("../omp/cli", () => ({ runOmpJson: async () => ({ "contextFiles.extra": { value: fake.extra, type: "array", description: "" } }) }));
vi.mock("../omp/sessions", () => ({ listProjects: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: vi.fn(), setPrefs: vi.fn() }));
vi.mock("../files", () => ({ writeText: (...args: unknown[]) => fake.write(...args) }));

register();
const call = (name: string, ...args: unknown[]) => fake.handlers.get(name)!(...args);
let folder: string;
beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "visual-omp-extra-instructions-"));
	fake.extra = ["AGENTS.local.md"];
	fake.write.mockReset();
	fake.write.mockImplementation((path: string, content: string) => writeFile(path, content));
});
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

describe("project extra instructions", () => {
	it("lists an extra file as additive alongside the primary instructions", async () => {
		await writeFile(join(folder, "AGENTS.md"), "Primary instructions");
		await writeFile(join(folder, "AGENTS.local.md"), "Extra instructions");
		const result = await call("project:instructions", folder) as ProjectInstructions;
		expect(result.activeRelPath).toBe("AGENTS.md");
		expect(result.files.find(file => file.relPath === "AGENTS.local.md")).toMatchObject({ kind: "extra", active: true, content: "Extra instructions", exists: true });
	});
	it("edits configured extra files and creates a missing configured file", async () => {
		const result = await call("project:instructions:write", folder, "AGENTS.local.md", "Project-specific notes") as ProjectInstructions;
		expect(await readFile(join(folder, "AGENTS.local.md"), "utf8")).toBe("Project-specific notes");
		expect(result.files.find(file => file.relPath === "AGENTS.local.md")?.active).toBe(true);
	});
	it("refuses arbitrary paths and filenames removed from configuration", async () => {
		await expect(call("project:instructions:write", folder, "../outside.md", "Bad")).rejects.toThrow("Not a project instructions file");
		fake.extra = [];
		await expect(call("project:instructions:write", folder, "AGENTS.local.md", "Stale")).rejects.toThrow("Not a project instructions file");
		expect(fake.write).not.toHaveBeenCalled();
	});
});
