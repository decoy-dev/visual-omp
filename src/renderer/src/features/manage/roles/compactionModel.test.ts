import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@shared/contracts/config";
import { matchingCompactionEntry, parseCompactionInput, planCompaction, type CompactionPolicy } from "./compactionModel";

const model: ModelInfo = { selector: "local/test", provider: "local", id: "test", name: "Test", kind: "chat", contextWindow: 200_000, contextWindowTiers: { standard: 200_000, extended: 1_000_000 }, maxOutputTokens: 10_000, reasoning: false, thinkingLevels: [], vision: false, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, longContext: { inputThreshold: 200_000, input: 2, output: 4, cacheRead: 0, cacheWrite: 0 } } };
const policy: CompactionPolicy = { enabled: true, extendedContext: false, thresholdPercent: -1, thresholdTokens: -1 };

describe("compaction input", () => {
	it.each([["90k", 90_000], ["1M", 1_000_000], ["90000", 90_000], ["f400k", "f400000"], ["80%", "80%"], ["12.5%", "12.5%"], ["", null]] as const)("persists %s as %s", (input, expected) => {
		expect(parseCompactionInput(input)).toBe(expected);
	});
	it.each(["0", "0%", "101%", "-1", "1.5k", "f80%", "9007199254740992", "words"])("rejects %s", input => {
		expect(() => parseCompactionInput(input)).toThrow("invalid");
	});
});

describe("compaction previews", () => {
	it("scales a base by the configured policy and drops the global fixed trigger", () => {
		expect(planCompaction(model, "90k", { ...policy, thresholdPercent: 80, thresholdTokens: 100_000 })).toMatchObject({ tokens: 72_000, basis: "base", base: 90_000, opensExtended: false });
		expect(planCompaction(model, "90k", policy).tokens).toBe(73_616);
	});
	it("uses exact fixed triggers, including inside the normal reserve", () => {
		expect(planCompaction(model, "f190k", policy)).toMatchObject({ tokens: 190_000, basis: "fixed", opensExtended: false });
	});
	it("opens extended context for a base above standard or a fixed trigger at standard", () => {
		expect(planCompaction(model, "200k", policy)).toMatchObject({ window: 200_000, opensExtended: false });
		expect(planCompaction(model, "f200k", policy)).toMatchObject({ window: 1_000_000, tokens: 200_000, opensExtended: true, premiumFrom: null });
		expect(planCompaction(model, "400k", policy)).toMatchObject({ window: 1_000_000, tokens: 340_000, opensExtended: true, premiumFrom: 200_000 });
		expect(planCompaction(model, "f400k", policy)).toMatchObject({ tokens: 400_000, opensExtended: true, premiumFrom: 200_000 });
	});
	it("honors an already extended window without another opt-in warning", () => {
		expect(planCompaction(model, "80%", { ...policy, extendedContext: true })).toMatchObject({ window: 1_000_000, tokens: 800_000, opensExtended: false });
	});
	it("clamps percentages and validates token boundaries", () => {
		expect(planCompaction(model, "100%", policy).tokens).toBe(198_000);
		expect(planCompaction(model, "0.5%", policy).tokens).toBe(2_000);
		expect(planCompaction(model, "1m", policy).error).toBeNull();
		expect(planCompaction(model, "1001k", policy).error).toBe("baseTooLarge");
		expect(planCompaction(model, "f1m", policy).error).toBe("fixedTooLarge");
	});
	it("resets to inherited percentages and retains global fixed limits when no entry applies", () => {
		expect(planCompaction(model, "", policy, "80%")).toMatchObject({ entry: null, tokens: 160_000 });
		expect(planCompaction(model, "", { ...policy, thresholdTokens: 400_000 })).toMatchObject({ tokens: 170_000, basis: "capped" });
	});
	it("recovers impossible small-window reserves exactly as omp does", () => {
		const small = { ...model, contextWindow: 8_000, contextWindowTiers: undefined };
		expect(planCompaction(small, "", policy).tokens).toBe(6_800);
		expect(planCompaction(small, "", { ...policy, reserveTokens: 7_000 }).tokens).toBe(1_000);
	});
	it("does not invent a trigger when disabled or the model's window is unknown", () => {
		expect(planCompaction(model, "90k", { ...policy, enabled: false }).tokens).toBeNull();
		expect(planCompaction({ ...model, contextWindow: null, contextWindowTiers: undefined }, "90k", policy).tokens).toBeNull();
	});
	it("marks disabled model limits as future behavior for inherited wildcards and extended-window drafts", () => {
		const disabled = { ...policy, modelThresholdsEnabled: false };
		const inherited = matchingCompactionEntry({ "local/*": "80%" }, model.selector);
		expect(planCompaction(model, "", disabled, inherited?.entry)).toMatchObject({
			appliesWhenEnabled: true, entry: null, tokens: 160_000, window: 200_000, opensExtended: false,
		});
		expect(planCompaction(model, "f400k", disabled, inherited?.entry)).toMatchObject({
			appliesWhenEnabled: true, entry: "f400000", tokens: 400_000, window: 1_000_000, opensExtended: true, premiumFrom: 200_000,
		});
		expect(planCompaction(model, "f400k", policy).appliesWhenEnabled).toBe(false);
	});
	it("selects the exact entry before the longest wildcard prefix and ignores cleared entries", () => {
		const entries = { "local/*": "80%", "local/te*": 90_000, "local/test": "f100000" };
		expect(matchingCompactionEntry(entries, model.selector)).toEqual({ key: "local/test", entry: "f100000" });
		expect(matchingCompactionEntry({ ...entries, "local/test": null }, model.selector)).toEqual({ key: "local/te*", entry: 90_000 });
	});
});
