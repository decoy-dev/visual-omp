import { access, readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configWritten, listModels, register } from "./config";
import { ompStatus } from "../omp/locate";

const fake = vi.hoisted(() => ({ calls: [] as string[][], overlays: [] as string[], version: "18.18.3", path: "/fixture/omp", fresh: false, broadcast: vi.fn() }));
vi.mock("../ipc", () => ({ handle: vi.fn(), broadcast: fake.broadcast }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ newUserApproval: "done", ompPath: fake.path }), setPrefs: vi.fn() }));
vi.mock("../env", () => ({ userEnv: async () => ({}) }));
vi.mock("node:child_process", () => ({
	execFile: (_bin: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => callback(null, `omp ${fake.version}`),
}));
vi.mock("../omp/rpc", () => ({ rpcRequest: vi.fn() }));
vi.mock("../omp/cli", () => ({
	runOmp: async (args: string[]) => {
		fake.calls.push(args);
		const overlayIndex = args.indexOf("--config");
		let window = 200_000;
		if (overlayIndex >= 0) {
			const file = args[overlayIndex + 1]!;
			fake.overlays.push(file);
			const config = await readFile(file, "utf8");
			window = config.includes("extendedContext: true") ? 1_000_000 : 200_000;
		}
		return { code: 0, stderr: "", stdout: JSON.stringify({ models: [{ provider: "local", id: "test", selector: "local/test", name: "Test", kind: "chat", contextWindow: fake.fresh ? 1_000_000 : window, maxTokens: 10_000, reasoning: fake.fresh, thinking: fake.fresh ? ["low", "high"] : null, input: fake.fresh ? ["text", "image"] : ["text"], pricingStatus: fake.fresh ? "fixed" : "included", cost: fake.fresh ? { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 } : null }] }) };
	},
}));

register();
beforeEach(async () => {
	configWritten(); fake.calls.length = 0; fake.overlays.length = 0;
	fake.version = "18.18.3"; fake.path = "/fixture/omp"; fake.fresh = false;
	await ompStatus(true);
	fake.broadcast.mockClear();
});

describe("model window policies", () => {
	it("lists ordinary models without extra policy reads, then resolves both tiers on request", async () => {
		const plain = await listModels("/fixture/project");
		expect(fake.calls).toHaveLength(1);
		expect(plain[0]?.contextWindowTiers).toBeUndefined();
		const enriched = await listModels("/fixture/project", false, true);
		expect(enriched[0]).toMatchObject({ contextWindow: 200_000, contextWindowTiers: { standard: 200_000, extended: 1_000_000 }, pricingStatus: "included" });
		expect(plain[0]?.contextWindowTiers).toBeUndefined();
		expect(fake.calls).toHaveLength(3);
		await listModels("/fixture/project", false, true);
		expect(fake.calls).toHaveLength(3);
	});
	it("removes the private overlay files after resolving model windows", async () => {
		await listModels(undefined, false, true);
		expect(fake.overlays).toHaveLength(2);
		for (const file of fake.overlays) await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.each(["version", "path"] as const)("discards both main catalog variants when the installed %s changes", async change => {
		const stale = await listModels("/fixture/project");
		await listModels("/fixture/project", false, true);
		await listModels("/fixture/other");
		expect(stale[0]).toMatchObject({ reasoning: false, vision: false, contextWindow: 200_000, cost: null });
		const previousCalls = fake.calls.length;
		fake.fresh = true;
		if (change === "version") fake.version = "18.18.5";
		else fake.path = "/fixture/other-omp";
		// The updater and minute refresh force a status read. A path preference also bypasses cached status.
		await ompStatus(change === "version");
		expect(fake.broadcast).toHaveBeenCalledWith("omp:status", expect.objectContaining({ path: fake.path, version: fake.version }));
		for (const models of await Promise.all([
			listModels("/fixture/project"),
			listModels("/fixture/project", false, true),
			listModels("/fixture/other"),
		])) {
			expect(models[0]).toMatchObject({
				reasoning: true, vision: true, thinkingLevels: ["low", "high"], contextWindow: 1_000_000,
				cost: { input: 8, output: 40, cacheRead: 0.2 },
			});
		}
		expect(fake.calls.length).toBeGreaterThan(previousCalls);
		const refreshedCalls = fake.calls.length;
		await ompStatus(true);
		await listModels("/fixture/project");
		expect(fake.calls).toHaveLength(refreshedCalls);
		expect(fake.broadcast).toHaveBeenCalledTimes(1);
	});
});
