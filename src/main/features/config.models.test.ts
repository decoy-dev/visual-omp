import { access, readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configWritten, listModels } from "./config";

const fake = vi.hoisted(() => ({ calls: [] as string[][], overlays: [] as string[] }));
vi.mock("../ipc", () => ({ handle: vi.fn(), broadcast: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ newUserApproval: "done" }), setPrefs: vi.fn() }));
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
		return { code: 0, stderr: "", stdout: JSON.stringify({ models: [{ provider: "local", id: "test", selector: "local/test", name: "Test", kind: "chat", contextWindow: window, maxTokens: 10_000, reasoning: false, thinking: null, input: ["text"], pricingStatus: "included", cost: null }] }) };
	},
}));

beforeEach(() => { configWritten(); fake.calls.length = 0; fake.overlays.length = 0; });

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
});
