import { appendFile, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { helperFileValidation, helperSessionFile } from "./helper-file";
import { SessionTail } from "./tail";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("resolves flat and nested qualified helper files using omp's companion folders", async () => {
	const root = await mkdtemp(join(tmpdir(), "vomp-helpers-")); roots.push(root);
	const parent = join(root, "session.jsonl");
	await mkdir(join(root, "session", "Atlas", "Atlas.Child"), { recursive: true });
	const flat = join(root, "session", "Atlas.jsonl");
	const nested = join(root, "session", "Atlas", "Atlas.Child.jsonl");
	const deep = join(root, "session", "Atlas", "Atlas.Child", "Atlas.Child.Leaf.jsonl");
	await Promise.all([flat, nested, deep].map(file => writeFile(file, "{}\n")));
	expect(await helperSessionFile(parent, "Atlas")).toBe(await realpath(flat));
	expect(await helperSessionFile(parent, "Atlas.Child")).toBe(await realpath(nested));
	expect(await helperSessionFile(parent, "Atlas.Child.Leaf")).toBe(await realpath(deep));
	expect(await helperSessionFile(parent, "Missing")).toBeNull();
});
it.each(["../secret", "a/b", "a\\b", ".", "..", "a..b", "", "a\0b"])("refuses traversal and invalid helper ids (%j)", async id => {
	expect(await helperSessionFile("/sessions/chat.jsonl", id)).toBeNull();
});

it("follows a growing helper file and publishes only complete new JSONL records", async () => {
	const root = await mkdtemp(join(tmpdir(), "vomp-helper-growth-")); roots.push(root);
	const file = join(root, "Atlas.jsonl");
	await writeFile(file, "{\"type\":\"session\",\"id\":\"helper\"}\n");
	const tail = new SessionTail(file);
	expect(await tail.read()).toEqual({ text: "{\"type\":\"session\",\"id\":\"helper\"}\n", reset: true });
	await appendFile(file, "{\"type\":\"message\",\"id\":\"reply\"");
	const partial = await tail.read();
	expect(partial?.text ?? "").toBe("");
	await appendFile(file, ",\"message\":{\"role\":\"assistant\",\"content\":[]}}\n");
	expect(await tail.read()).toEqual({ text: "{\"type\":\"message\",\"id\":\"reply\",\"message\":{\"role\":\"assistant\",\"content\":[]}}\n", reset: false });
});

it("refuses file symlinks and nested directory symlinks outside the helper directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "vomp-helper-links-")); roots.push(root);
	const helperDir = join(root, "session"), outside = join(root, "outside");
	await mkdir(helperDir); await mkdir(outside);
	await writeFile(join(outside, "Atlas.jsonl"), "private\n");
	await writeFile(join(outside, "Atlas.Child.jsonl"), "private child\n");
	await symlink(join(outside, "Atlas.jsonl"), join(helperDir, "Atlas.jsonl"), "file");
	await symlink(outside, join(helperDir, "Atlas"), "junction");
	expect(await helperSessionFile(join(root, "session.jsonl"), "Atlas")).toBeNull();
	expect(await helperSessionFile(join(root, "session.jsonl"), "Atlas.Child")).toBeNull();
});

it.each(["file", "directory"] as const)("rechecks helper containment when the %s is replaced after resolution", async kind => {
	const root = await mkdtemp(join(tmpdir(), "vomp-helper-reopen-")); roots.push(root);
	const helperDir = join(root, "session"), outside = join(root, "outside");
	await mkdir(join(helperDir, "Atlas"), { recursive: true }); await mkdir(outside);
	const file = join(helperDir, "Atlas", "Atlas.Child.jsonl");
	await writeFile(file, "{\"type\":\"session\",\"id\":\"safe\"}\n");
	await writeFile(join(outside, "Atlas.Child.jsonl"), "private\n");
	const resolved = await helperSessionFile(join(root, "session.jsonl"), "Atlas.Child");
	expect(resolved).not.toBeNull();
	const tail = new SessionTail(resolved!, helperFileValidation(resolved!));
	expect((await tail.read())?.text).toContain("safe");
	if (kind === "file") { await rm(file); await symlink(join(outside, "Atlas.Child.jsonl"), file, "file"); }
	else { await rename(join(helperDir, "Atlas"), join(helperDir, "old")); await symlink(outside, join(helperDir, "Atlas"), "junction"); }
	await expect(tail.read()).rejects.toThrow(/symbolic link|path changed/i);
});
