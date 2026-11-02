import type { ModelInfo } from "@shared/contracts/config";
import { describe, expect, it } from "vitest";
import { containsCurrent, modelFamily, modelRows, modelTree, searchModelTree } from "./modelTree";

function model(id: string, name = id, provider = "anthropic"): ModelInfo {
	return { id, name, provider, selector: `${provider}/${id}`, kind: "chat", contextWindow: 200000, maxOutputTokens: null, reasoning: true, thinkingLevels: [], vision: true, cost: null };
}

describe("conservative model families", () => {
	it.each([
		["claude-opus-5-5", "Claude Opus 5.5", "Claude Opus", "5.5"],
		["claude-opus-5", "Claude Opus 5", "Claude Opus", "5"],
		["claude-opus-4-6", "Claude Opus 4.6", "Claude Opus", "4.6"],
		["claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet", "Claude Sonnet", "3.5-20241022"],
		["claude-haiku-4-5-20251001", "Claude Haiku 4.5", "Claude Haiku", "4.5-20251001"],
		["claude-opus-4-6[1m]", "Claude Opus 4.6 (1M context)", "Claude Opus", "4.6 (1M context)"],
		["claude-opus-latest", "Claude Opus latest", "Claude Opus", "latest"],
		["gpt-5.4-mini", "GPT-5.4 Mini", "GPT Mini", "5.4"],
		["gpt-4o-mini-2024-07-18", "GPT-4o Mini", "GPT Mini", "4o-2024-07-18"],
		["gemini-2.5-flash-lite-preview-06-17", "Gemini 2.5 Flash-Lite Preview", "Gemini Flash-Lite", "2.5-preview-06-17"],
	])("recognizes bounded naming shape %s", (id, name, family, version) => {
		expect(modelFamily(model(id, name))).toEqual({ name: family, version });
	});

	// Exact id/name tuples from omp tag v18.15.0, packages/catalog/src/models.json.
	it.each([
		["anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "Claude Haiku", "4.5"],
		["anthropic", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", "Claude Haiku", "4.5-20251001"],
		["anthropic", "claude-opus-4-6", "Claude Opus 4.6", "Claude Opus", "4.6"],
		["openai", "gpt-4o-mini", "GPT-4o mini", "GPT Mini", "4o"],
		["google", "gemini-2.5-pro-preview-05-06", "Gemini 2.5 Pro Preview 05-06", "Gemini Pro", "2.5-preview-05-06"],
		["openrouter", "anthropic/claude-opus-4.1", "Claude Opus 4.1", "Claude Opus", "4.1"],
		["openrouter", "anthropic/claude-haiku-4.5", "Claude Haiku 4.5", "Claude Haiku", "4.5"],
	])("recognizes canonical %s catalog tuple %s", (provider, id, name, family, version) => {
		expect(modelFamily(model(id, name, provider))).toEqual({ name: family, version });
	});

	it.each(["local", "custom-gateway", "anthropic"])("leaves namespaced custom routes on %s directly selectable", provider => {
		expect(modelFamily(model("anthropic/claude-opus-5", "Claude Opus 5", provider))).toBeNull();
	});

	it.each([
		["my-claude-opus-5", "Claude Opus 5"],
		["company/claude-opus-5", "Claude Opus 5"],
		["claude-opus-5-custom", "Claude Opus 5 custom"],
		["claude-opus-5-500", "Claude Opus 5.500"],
		["claude-opusish-5", "Claude Opusish 5"],
		["claude-opus-5", "Claude Sonnet 5"],
		["claude-opus-5", "My custom 5"],
		["claude-opus-5", "Claude Opus 5.5"],
		["claude-opus-5", "Claude Opus 4.6"],
		["claude-opus-4-6-20260101", "Claude Opus 4.6 20260102"],
		["claude-opus-4-6", "Claude Opus 4.6 (1M context)"],
		["claude-fable-5", "Claude Fable 5"],
		["gpt-5.6-luna", "GPT-5.6-Luna"],
		["my-chat-2", "My chat 2"],
		["my-chat-3", "My chat 3"],
		["gpt-5.4-mini-custom", "GPT-5.4 Mini custom"],
		["gpt-6-luna", "GPT-6 Luna"],
		["gemini-2.5-flashlight", "Gemini 2.5 Flashlight"],
		["gemini-2.5-pro-custom", "Gemini 2.5 Pro custom"],
	])("keeps ambiguous identifier %s directly selectable", (id, name) => {
		expect(modelFamily(model(id, name))).toBeNull();
	});

	it("keeps OpenRouter batch and unsupported display prefixes as direct leaves", () => {
		expect(modelFamily(model("anthropic/claude-haiku-4.5:batch", "Claude Haiku 4.5 (batch)", "openrouter"))).toBeNull();
		expect(modelFamily(model("anthropic/claude-opus-4.1", "Anthropic: Claude Opus 4.1", "openrouter"))).toBeNull();
	});

	it("separates Claude families and host providers while preserving every leaf object", () => {
		const entries = [
			model("claude-opus-5-5", "Claude Opus 5.5"), model("claude-opus-5", "Claude Opus 5"), model("claude-opus-4-6", "Claude Opus 4.6"),
			model("claude-sonnet-5", "Claude Sonnet 5"), model("claude-sonnet-4-6", "Claude Sonnet 4.6"),
			model("anthropic/claude-opus-5-5", "Claude Opus 5.5", "openrouter"), model("anthropic/claude-opus-5", "Claude Opus 5", "openrouter"),
		];
		const tree = modelTree(entries);
		expect(tree.map(node => node.label)).toEqual(["anthropic", "openrouter"]);
		expect(tree[0]?.children.map(node => node.label)).toEqual(["Claude Opus", "Claude Sonnet"]);
		const opus = tree[0]!.children[0]!;
		expect(opus.kind !== "model" && opus.children.map(node => node.label)).toEqual(["5.5", "5", "4.6"]);
		const leaves = modelRows(tree, () => true).filter(row => row.node.kind === "model");
		expect(leaves).toHaveLength(entries.length);
		for (const row of leaves) if (row.node.kind === "model") expect(entries).toContain(row.node.model);
	});

	it("never folds a singleton or unknown models into a family", () => {
		const tree = modelTree([model("claude-opus-5", "Claude Opus 5"), model("local-2", "Local 2"), model("local-3", "Local 3")]);
		expect(tree[0]!.children.map(node => [node.kind, node.label])).toEqual([["model", "Claude Opus 5"], ["model", "Local 2"], ["model", "Local 3"]]);
	});

	it("retains aliases, snapshots and window variants as distinct leaves with exact selectors", () => {
		const entries = ["claude-opus-4-6", "claude-opus-4-6-20260101", "claude-opus-4-6[1m]", "claude-opus-4-6:1m", "claude-opus-latest"].map(id => model(id));
		const rows = modelRows(modelTree(entries), () => true).filter(row => row.node.kind === "model");
		expect(new Set(rows.map(row => row.node.key)).size).toBe(5);
		expect(rows.map(row => row.node.kind === "model" && row.node.model.selector).sort()).toEqual(entries.map(entry => entry.selector).sort());
	});

	it("searches provider, name and id through collapsed descendants without changing family identity", () => {
		const tree = modelTree([model("claude-opus-5", "Claude Opus 5"), model("claude-opus-4-6-20260101", "Claude Opus 4.6"), model("custom", "Workhorse", "local")]);
		const result = searchModelTree(tree, "ANTHROPIC 20260101");
		expect(result[0]!.children[0]!.label).toBe("Claude Opus");
		expect(modelRows(result, () => true).filter(row => row.node.kind === "model")).toHaveLength(1);
		expect(searchModelTree(tree, "workhorse")[0]!.label).toBe("local");
		expect(searchModelTree(tree, "local")[0]!.children).toHaveLength(1);
		expect(searchModelTree(tree, "nothing")).toEqual([]);
		expect(containsCurrent(tree[0]!, { provider: "anthropic", id: "claude-opus-5" })).toBe(true);
		expect(containsCurrent(tree[0]!, { provider: "openrouter", id: "claude-opus-5" })).toBe(false);
	});
});
