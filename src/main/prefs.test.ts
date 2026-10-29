import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	contents: null as string | null,
	readError: null as Error | null,
	temporary: "",
	readFileSync: vi.fn(),
	mkdir: vi.fn(),
	writeFile: vi.fn(),
	rename: vi.fn(),
	broadcast: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getPath: () => "/fixture/visual-omp-profile" } }));
vi.mock("node:fs", () => ({ readFileSync: fake.readFileSync }));
vi.mock("node:fs/promises", () => ({ mkdir: fake.mkdir, writeFile: fake.writeFile, rename: fake.rename }));
vi.mock("./ipc", () => ({ broadcast: fake.broadcast }));

// Preferences load once at module initialization, so each test imports a fresh module after configuring the profile.
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	fake.contents = null;
	fake.readError = null;
	fake.temporary = "";
	fake.readFileSync.mockImplementation(() => {
		if (fake.readError) throw fake.readError;
		if (fake.contents === null) throw Object.assign(new Error("Preferences file is missing"), { code: "ENOENT" });
		return fake.contents;
	});
	fake.mkdir.mockResolvedValue(undefined);
	fake.writeFile.mockImplementation(async (_path: string, contents: string) => {
		fake.temporary = contents;
	});
	fake.rename.mockImplementation(async () => {
		fake.contents = fake.temporary;
	});
});

describe("first-run setup preferences", () => {
	it("starts setup and retains the pending approval default for a fresh profile", async () => {
		const { getPrefs } = await import("./prefs");
		expect(getPrefs()).toMatchObject({ setupCompleted: false, newUserApproval: "pending" });
		expect(fake.readFileSync).toHaveBeenCalledWith(join("/fixture/visual-omp-profile", "preferences.json"), "utf8");
		expect(fake.writeFile).not.toHaveBeenCalled();
	});

	it("treats an existing profile without the setup preference as complete", async () => {
		fake.contents = JSON.stringify({ theme: "dark", tourCompleted: true });
		const { getPrefs } = await import("./prefs");
		expect(getPrefs()).toMatchObject({ setupCompleted: true, theme: "dark", tourCompleted: true });
		expect(getPrefs().newUserApproval).toBeUndefined();
		expect(fake.writeFile).not.toHaveBeenCalled();
	});

	it.each([true, false])("preserves a stored setupCompleted value of %s", async setupCompleted => {
		fake.contents = JSON.stringify({ setupCompleted, newUserApproval: "done" });
		const { getPrefs } = await import("./prefs");
		expect(getPrefs()).toMatchObject({ setupCompleted, newUserApproval: "done" });
	});

	it("keeps setup complete when an existing preferences file cannot be read", async () => {
		fake.readError = Object.assign(new Error("Preferences file cannot be read"), { code: "EACCES" });
		const { getPrefs } = await import("./prefs");
		expect(getPrefs().setupCompleted).toBe(true);
		expect(getPrefs().newUserApproval).toBeUndefined();
	});

	it("keeps setup complete when an existing preferences file contains invalid JSON", async () => {
		fake.contents = "{invalid JSON";
		const { getPrefs } = await import("./prefs");
		expect(getPrefs().setupCompleted).toBe(true);
		expect(getPrefs().newUserApproval).toBeUndefined();
	});

	it.each([true, false])("persists setupCompleted as %s and restores it on the next load", async setupCompleted => {
		fake.contents = JSON.stringify({ setupCompleted: !setupCompleted, newUserApproval: "done" });
		const { getPrefs, setPrefs } = await import("./prefs");
		const preferences = setPrefs({ setupCompleted });
		expect(getPrefs().setupCompleted).toBe(setupCompleted);
		expect(fake.broadcast).toHaveBeenCalledWith("app:prefs", preferences);
		await vi.waitFor(() => expect(fake.rename).toHaveBeenCalledOnce());
		const file = join("/fixture/visual-omp-profile", "preferences.json");
		expect(fake.writeFile).toHaveBeenCalledWith(`${file}.tmp`, expect.any(String));
		expect(fake.rename).toHaveBeenCalledWith(`${file}.tmp`, file);
		expect(JSON.parse(fake.contents!)).toMatchObject({ setupCompleted, newUserApproval: "done" });
		vi.resetModules();
		const reloaded = await import("./prefs");
		expect(reloaded.getPrefs()).toMatchObject({ setupCompleted, newUserApproval: "done" });
	});
});
