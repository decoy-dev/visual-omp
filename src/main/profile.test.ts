import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ packaged: true, setPath: vi.fn(), setName: vi.fn() }));
vi.mock("electron", () => ({ app: { get isPackaged() { return fake.packaged; }, getPath: () => "/app-data", setPath: fake.setPath, setName: fake.setName } }));
let scratch: string;
beforeEach(() => {
	vi.resetModules(); vi.clearAllMocks(); fake.packaged = true; vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", ""); vi.stubEnv("VOMP_DEV_PROFILE", "");
	scratch = mkdtempSync(join(tmpdir(), "vomp-profile-test-"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true }); });

// These imports exercise profile setup at module load for each launch environment.
it("leaves the packaged profile unchanged during ordinary launches", async () => {
	vi.stubEnv("VOMP_DEV_PROFILE", join(scratch, "profile"));
	await import("./profile");
	expect(fake.setPath).not.toHaveBeenCalled();
});
it("uses the exact absolute scratch profile in packaged isolation launches", async () => {
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", "1");
	const profile = join(scratch, "isolation-profile");
	vi.stubEnv("VOMP_DEV_PROFILE", profile);
	await import("./profile");
	expect(fake.setPath).toHaveBeenCalledWith("userData", profile);
});
it("rejects isolation launches without an absolute profile before reading app paths", async () => {
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", "1");
	vi.stubEnv("VOMP_DEV_PROFILE", "relative-profile");
	await expect(import("./profile")).rejects.toThrow("absolute scratch");
	expect(fake.setPath).not.toHaveBeenCalled();
});
it("retains relative development profile names and accepts absolute overrides", async () => {
	fake.packaged = false;
	vi.stubEnv("VOMP_DEV_PROFILE", "relative-profile");
	await import("./profile");
	expect(fake.setPath).toHaveBeenCalledWith("userData", join("/app-data", "relative-profile"));
	vi.resetModules();
	const profile = join(scratch, "development-profile");
	vi.stubEnv("VOMP_DEV_PROFILE", profile);
	await import("./profile");
	expect(fake.setPath).toHaveBeenCalledWith("userData", profile);
});
it("keeps downloads inside an explicit scratch profile and leaves ordinary development runs alone", async () => {
	fake.packaged = false;
	vi.stubEnv("VOMP_DEV_PROFILE", "relative-profile");
	await import("./profile");
	expect(fake.setPath).not.toHaveBeenCalledWith("downloads", expect.anything());
	vi.resetModules();
	const profile = join(scratch, "tour", "app-profile");
	vi.stubEnv("VOMP_DEV_PROFILE", profile);
	await import("./profile");
	expect(fake.setPath).toHaveBeenCalledWith("downloads", join(profile, "Downloads"));
	expect(existsSync(join(profile, "Downloads"))).toBe(true);
});
