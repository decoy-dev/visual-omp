import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clone, resolveCloneTarget } from "./clone";

const fake = vi.hoisted(() => ({ runGit: vi.fn() }));
vi.mock("./run", () => ({ runGit: (...args: unknown[]) => fake.runGit(...args) }));

describe("resolveCloneTarget", () => {
	it("resolves a single directory name inside parentDir", () => {
		const parent = resolve("repos");
		expect(resolveCloneTarget(parent, "my-app")).toBe(join(parent, "my-app"));
	});

	it("rejects traversal, path separators, drive colons, NUL bytes, and blank names", () => {
		const parent = resolve("repos");
		for (const bad of ["", " ", ".", "..", "../escape", "..\\escape", "a/b", "a\\b", "c:foo", "bad\0name"]) {
			expect(() => resolveCloneTarget(parent, bad), JSON.stringify(bad)).toThrow(/Invalid repository folder name/);
		}
	});
});

describe("clone", () => {
	let sandbox = "";
	afterEach(async () => {
		vi.clearAllMocks();
		if (sandbox) await rm(sandbox, { recursive: true, force: true });
		sandbox = "";
	});

	it("refuses traversal targets before invoking git or removing existing sibling directories", async () => {
		sandbox = await mkdtemp(join(tmpdir(), "vomp-clone-test-"));
		const parentDir = join(sandbox, "workspace");
		const sibling = join(sandbox, "important.txt");
		await mkdir(parentDir);
		await writeFile(sibling, "keep");

		await expect(
			clone({ id: "c1", url: "https://github.com/org/repo.git", parentDir, name: "../workspace" }, () => {}),
		).rejects.toThrow(/Invalid repository folder name/);
		expect(fake.runGit).not.toHaveBeenCalled();
	});
});
