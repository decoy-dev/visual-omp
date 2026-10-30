import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordUpdateCheck, UPDATE_COUNT_URL } from "./update-count";

beforeEach(() => {
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("VITEST", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("recordUpdateCheck", () => {
	it("sends only the app version, platform and architecture with a five-second timeout", () => {
		const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", send);
		const timeout = vi.spyOn(AbortSignal, "timeout");
		expect(recordUpdateCheck("0.7.1", true)).toBeUndefined();
		expect(send).toHaveBeenCalledExactlyOnceWith(UPDATE_COUNT_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ version: "0.7.1", platform: process.platform, arch: process.arch }),
			signal: expect.any(AbortSignal),
			redirect: "error",
			credentials: "omit",
		});
		expect(timeout).toHaveBeenCalledExactlyOnceWith(5_000);
	});

	it("returns immediately while the request remains pending", () => {
		vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
		expect(recordUpdateCheck("0.7.1", true)).toBeUndefined();
	});

	it("contains asynchronous request failures", async () => {
		const failed = Promise.reject(new Error("offline"));
		vi.stubGlobal("fetch", vi.fn(() => failed));
		expect(recordUpdateCheck("0.7.1", true)).toBeUndefined();
		await Promise.resolve();
	});

	it("contains synchronous request failures", () => {
		vi.stubGlobal("fetch", vi.fn(() => { throw new Error("fetch unavailable"); }));
		expect(() => recordUpdateCheck("0.7.1", true)).not.toThrow();
	});

	it("skips development builds and test environments", () => {
		const send = vi.fn();
		vi.stubGlobal("fetch", send);
		recordUpdateCheck("0.7.1", false);
		vi.stubEnv("NODE_ENV", "test");
		recordUpdateCheck("0.7.1", true);
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("VITEST", "true");
		recordUpdateCheck("0.7.1", true);
		expect(send).not.toHaveBeenCalled();
	});
});
