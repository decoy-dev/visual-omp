import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Dynamic imports exercise startup-only environment capture after each module reset.

const fake = vi.hoisted(() => ({ inspector: vi.fn(), appendSwitch: vi.fn() }));
vi.mock("node:inspector", () => ({ open: fake.inspector }));
vi.mock("electron", () => ({ app: { commandLine: { appendSwitch: fake.appendSwitch } } }));
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vomp-isolation-"));
	vi.resetModules();
	vi.clearAllMocks();
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", "");
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_FILE", join(root, "isolation.html"));
	vi.stubEnv("VOMP_DEV_PROFILE", join(root, "profile"));
	await writeFile(join(root, "isolation.html"), "fixture");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("keeps scripts and debug listeners off unless main captured the exact startup switch", async () => {
	const gate = await import("./preview-isolation-test");
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", "1");
	expect(gate.isIsolationTestDocument(await realpath(join(root, "isolation.html")), true)).toBe(false);
	gate.startPreviewIsolationInspector();
	expect(fake.inspector).not.toHaveBeenCalled();
	expect(fake.appendSwitch).not.toHaveBeenCalled();
});

it("allows only the exact saved fixture, including a canonicalized temporary path", async () => {
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", "1");
	const gate = await import("./preview-isolation-test");
	const file = await realpath(join(root, "isolation.html"));
	expect(gate.isIsolationTestDocument(file, false)).toBe(false);
	expect(gate.isIsolationTestDocument(file, true)).toBe(true);
	expect(gate.isIsolationTestDocument(join(root, "other.html"), true)).toBe(false);
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_FILE", join(root, "other.html"));
	expect(gate.isIsolationTestDocument(file, true)).toBe(true);
	gate.startPreviewIsolationInspector();
	expect(fake.inspector).toHaveBeenCalledWith(9229, "127.0.0.1", false);
	expect(fake.appendSwitch.mock.calls).toEqual([["remote-debugging-address", "127.0.0.1"], ["remote-debugging-port", "9333"]]);
});

it("refuses debug startup with a missing fixture or nonabsolute scratch profile", async () => {
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", "1");
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_FILE", "isolation.html");
	const gate = await import("./preview-isolation-test");
	expect(() => gate.startPreviewIsolationInspector()).toThrow("absolute fixture");
	expect(fake.inspector).not.toHaveBeenCalled();
});

it("pins an existing canonical parent before the fixture file is created", async () => {
	await rm(join(root, "isolation.html"));
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", "1");
	const gate = await import("./preview-isolation-test");
	await writeFile(join(root, "isolation.html"), "created later");
	expect(gate.isIsolationTestDocument(await realpath(join(root, "isolation.html")), true)).toBe(true);
});

it("rejects fixture symlink retargeting after startup and after authorization", async () => {
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", "1");
	const gate = await import("./preview-isolation-test");
	const path = await realpath(join(root, "isolation.html"));
	expect(gate.isIsolationTestDocument(path, true)).toBe(true);
	await rename(path, join(root, "original.html"));
	await writeFile(join(root, "other.html"), "changed target");
	await symlink(join(root, "other.html"), path, "file");
	const actual = await realpath(path);
	const file = await open(actual);
	try {
		const info = await file.stat();
		expect(await file.readFile("utf8")).toBe("changed target");
		expect(gate.isIsolationTestDocument(path, true, { path: actual, dev: info.dev, ino: info.ino })).toBe(false);
		expect(gate.isIsolationTestDocument(actual, true)).toBe(false);
	} finally { await file.close(); }
	await rm(path);
	await symlink(join(root, "original.html"), path, "file");
	expect(gate.isIsolationTestDocument(path, true)).toBe(false);
});

it("rejects a retargeted ancestor symlink, including the original canonical file", async () => {
	for (const folder of ["first", "second"]) {
		await mkdir(join(root, folder));
		await writeFile(join(root, folder, "isolation.html"), folder);
	}
	const alias = join(root, "alias");
	await symlink(join(root, "first"), alias, process.platform === "win32" ? "junction" : "dir");
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", "1");
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_FILE", join(alias, "isolation.html"));
	const gate = await import("./preview-isolation-test");
	const original = await realpath(join(alias, "isolation.html"));
	expect(gate.isIsolationTestDocument(original, true)).toBe(true);
	await rm(alias);
	await symlink(join(root, "second"), alias, process.platform === "win32" ? "junction" : "dir");
	expect(gate.isIsolationTestDocument(original, true)).toBe(false);
	expect(gate.isIsolationTestDocument(await realpath(join(alias, "isolation.html")), true)).toBe(false);
});

it("rejects read bytes from an inode replaced between authorization and reading", async () => {
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", "1");
	const gate = await import("./preview-isolation-test");
	const path = await realpath(join(root, "isolation.html"));
	expect(gate.isIsolationTestDocument(path, true)).toBe(true);
	const file = await open(path);
	try {
		const info = await file.stat();
		await rename(path, join(root, "previous.html"));
		await writeFile(path, "replacement");
		expect(await file.readFile("utf8")).toBe("fixture");
		expect(gate.isIsolationTestDocument(path, true, { path, dev: info.dev, ino: info.ino })).toBe(false);
	} finally { await file.close(); }
});
