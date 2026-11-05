import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ packaged: true, setPath: vi.fn(), setName: vi.fn() }));
vi.mock("electron", () => ({ app: { get isPackaged() { return fake.packaged; }, getPath: () => "/app-data", setPath: fake.setPath, setName: fake.setName } }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); fake.packaged = true; vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", ""); vi.stubEnv("VOMP_DEV_PROFILE", ""); });
afterEach(() => { vi.unstubAllEnvs(); });

// These imports exercise profile setup at module load for each launch environment.
it("leaves the packaged profile unchanged during ordinary launches", async () => {
	vi.stubEnv("VOMP_DEV_PROFILE", resolve("scratch"));
	await import("./profile");
	expect(fake.setPath).not.toHaveBeenCalled();
});
it("uses the exact absolute scratch profile in packaged isolation launches", async () => {
	vi.stubEnv("VOMP_PREVIEW_ISOLATION_TEST", "1");
	const profile = resolve("scratch-isolation-profile");
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
	const profile = resolve("scratch-development-profile");
	vi.stubEnv("VOMP_DEV_PROFILE", profile);
	await import("./profile");
	expect(fake.setPath).toHaveBeenLastCalledWith("userData", profile);
});
