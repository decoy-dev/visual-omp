import { describe, expect, it } from "vitest";
import type { ModelInfo, ModelPresetInfo, ModelRolesState } from "@shared/contracts/config";
import { activeModelPreset, modelPriceBadge, orderRoles } from "./rolesModel";

const model: ModelInfo = { selector: "local/test", provider: "local", id: "test", name: "Test", kind: "chat", contextWindow: 200_000, maxOutputTokens: 10_000, reasoning: false, thinkingLevels: [], vision: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, longContext: null } };
const state = (values: Record<string, string | null>, thinking: ModelRolesState["defaultThinkingLevel"] = "high"): ModelRolesState => ({
	cwd: null, storage: "global", storageSource: "default", defaultThinkingLevel: thinking,
	roles: Object.entries(values).map(([id, value]) => ({ id, name: id, builtIn: true, section: "chat", acceptsKinds: ["chat"], color: null, hidden: false, inCycle: false, value, model: value, thinking: null, source: value ? "global" : "default", globalValue: value, projectValue: null })),
});
const preset = (name: string, modelRoles: Record<string, string>, thinking: ModelPresetInfo["defaultThinkingLevel"] = null): ModelPresetInfo => ({ name, modelRoles, defaultThinkingLevel: thinking, source: "global", problem: null });

describe("active model presets", () => {
	it("matches identical role values and picks the first alphabetical preset", () => {
		expect(activeModelPreset([preset("zeta", { default: "local/test:high" }), preset("alpha", { default: "local/test:high" })], state({ default: "local/test:high", widget: null }))).toBe("alpha");
	});
	it("requires the same thinking level only when the preset recorded one", () => {
		expect(activeModelPreset([preset("high", { default: "local/test" }, "high")], state({ default: "local/test" }, "low"))).toBeNull();
		expect(activeModelPreset([preset("any", { default: "local/test" })], state({ default: "local/test" }, "low"))).toBe("any");
	});
	it("does not match a subset, a different suffix, or a malformed preset", () => {
		expect(activeModelPreset([preset("one", { default: "local/test" })], state({ default: "local/test", widget: "@smol" }))).toBeNull();
		expect(activeModelPreset([preset("one", { default: "local/test:low" })], state({ default: "local/test:high" }))).toBeNull();
		expect(activeModelPreset([{ ...preset("one", {}), problem: "Invalid" }], state({}))).toBeNull();
	});
	it("keeps the widget role among the built-in chat roles", () => {
		const roles = state({ image: null, widget: null, task: null }).roles;
		expect(orderRoles(roles).map(role => role.id)).toEqual(["task", "widget", "image"]);
	});
});

describe("model pricing badges", () => {
	it.each(["included", "unknown", "variable", undefined] as const)("never marks %s zero-priced metadata as cheap", pricingStatus => {
		expect(modelPriceBadge({ ...model, pricingStatus })).toBeNull();
	});
	it("labels free explicitly and only marks eligible fixed prices cheap", () => {
		expect(modelPriceBadge({ ...model, pricingStatus: "free" })).toBe("free");
		expect(modelPriceBadge({ ...model, pricingStatus: "fixed" })).toBe("cheap");
		expect(modelPriceBadge({ ...model, pricingStatus: "fixed", cost: { ...model.cost!, input: 1 } })).toBe("cheap");
		expect(modelPriceBadge({ ...model, pricingStatus: "fixed", cost: { ...model.cost!, input: 1.01 } })).toBeNull();
		expect(modelPriceBadge({ ...model, pricingStatus: "fixed", cost: null })).toBeNull();
	});
});
