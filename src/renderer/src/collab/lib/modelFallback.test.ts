import type { AssistantMessage, FallbackContent, ModelChangeEntry, SessionEntry, WireModel } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import { activeBranch } from "../../state/history";
import { composerModel, continuesAssistantModel, isModelFallback, modelFallbacks, modelSetupVisible, providerFallback } from "./modelFallback";

const primary = "anthropic/claude-opus-5-5";
const target = "openai-codex/gpt-6-luna";
const base = (id: string) => ({ id, parentId: null, timestamp: "2026-10-08T18:43:38.714Z" });
const change = (id: string, model: string, resolvedModelIsFallback?: boolean): ModelChangeEntry => ({ ...base(id), type: "model_change", model, role: "fallback", resolvedModelIsFallback });
const selected = change("initial", primary, false);
const swapped = change("switch", target, true);
const live: WireModel = { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna", contextWindow: 100000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
function message(patch: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", content: [], provider: "anthropic", model: "claude-opus-5-5", usage, stopReason: "stop", timestamp: 1791485018333, ...patch };
}
const entry = (m: AssistantMessage): SessionEntry => ({ ...base("reply"), type: "message", message: m });
const error = message({
	stopReason: "error",
	errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=8781000',
	retryRecovery: { kind: "auto-retry", recovery: "model", supersededBy: { provider: live.provider, model: live.id } },
});
const providerBlock: FallbackContent = { type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-5-5" } };

describe("recorded model fallbacks", () => {
	it("starts a new reply header when the model or provider changes within a turn", () => {
		expect(continuesAssistantModel(message(), message())).toBe(true);
		expect(continuesAssistantModel(message(), message({ model: "other" }))).toBe(false);
		expect(continuesAssistantModel(message(), message({ provider: "other" }))).toBe(false);
		expect(continuesAssistantModel(null, message())).toBe(false);
	});

	it("distinguishes the fallback flag from a manual choice or primary restoration", () => {
		expect(isModelFallback(swapped)).toBe(true);
		expect(isModelFallback(change("manual", target, false))).toBe(false);
		expect(isModelFallback(change("older", target))).toBe(false);
		expect(modelFallbacks([selected, change("manual", target, false)]).size).toBe(0);
	});

	it("quotes a matching recorded recovery error without relabelling rate limits as usage exhaustion", () => {
		const fallback = modelFallbacks([selected, swapped, entry(error)]).get("switch");
		expect(fallback).toEqual({ from: primary, to: target, source: "retry", reason: error.errorMessage });
	});

	it("does not infer a reason from a nearby error, a credential retry or a different recovery target", () => {
		for (const retryRecovery of [undefined, { ...error.retryRecovery!, recovery: "credential" as const }, { ...error.retryRecovery!, supersededBy: { provider: "other", model: "other" } }]) {
			expect(modelFallbacks([selected, swapped, entry({ ...error, retryRecovery })]).get("switch")?.reason).toBeUndefined();
		}
	});

	it("does not turn account rotation or same-model retry into a model fallback", () => {
		const credential = { ...base("credential"), type: "credential_pin", provider: "anthropic", hash: "redacted" } as unknown as SessionEntry;
		expect(modelFallbacks([selected, credential, entry({ ...error, retryRecovery: { kind: "auto-retry", recovery: "credential" } })]).size).toBe(0);
		expect(composerModel([selected, credential], undefined, null).fallback).toBeNull();
	});

	it("keeps a definite fallback visible with missing original model and reason", () => {
		expect(modelFallbacks([swapped]).get("switch")).toEqual({ from: undefined, to: target, source: "retry" });
		expect(composerModel([swapped], live, null).fallback?.from).toBeUndefined();
		expect(modelFallbacks([change("blank", "", true)]).size).toBe(0);
		expect(composerModel([], undefined, null)).toEqual({ model: null, selectedModel: null, fallback: null });
	});

	it("stops error association at another choice, user prompt or response", () => {
		const prompt: SessionEntry = { ...base("prompt"), type: "message", message: { role: "user", content: "continue", timestamp: 0 } };
		for (const boundary of [change("manual", primary, false), prompt, entry(message())]) {
			expect(modelFallbacks([selected, swapped, boundary, entry(error)]).get("switch")?.reason).toBeUndefined();
		}
	});

	it("uses only the branch supplied by the transcript", () => {
		const fork = { ...change("fork", primary, false), parentId: "initial" };
		const fallback = { ...swapped, parentId: "initial" };
		expect(modelFallbacks(activeBranch([selected, fallback, fork])).size).toBe(0);
	});

	it("keeps the original model through a fallback chain and clears on a manual change", () => {
		const third = change("third", "google/gemini", true);
		expect(composerModel([selected, swapped, third], undefined, null)).toMatchObject({ model: { provider: "google", id: "gemini" }, fallback: { from: primary, to: "google/gemini" } });
		expect(composerModel([selected, swapped, change("manual", target, false)], live, null).fallback).toBeNull();
	});

	it("keeps an unknown original unknown through B to C until a non-fallback choice resets the chain", () => {
		const third = change("third", "google/gemini", true);
		expect(composerModel([swapped, third], undefined, null).fallback).toMatchObject({ from: undefined, to: "google/gemini" });
		expect(composerModel([swapped, third, selected, change("new-fallback", target, true)], live, null).fallback?.from).toBe(primary);
	});

	it("hides ordinary setup before the first prompt, including in Verbose", () => {
		const thinking: SessionEntry = { ...base("thinking"), type: "thinking_level_change", thinkingLevel: "high" };
		for (const verbose of [false, true]) {
			expect(modelSetupVisible(selected, verbose, false)).toBe(false);
			expect(modelSetupVisible(thinking, verbose, false)).toBe(false);
			expect(modelSetupVisible(swapped, verbose, false)).toBe(true);
			expect(modelSetupVisible(selected, verbose, true)).toBe(true);
		}
		expect(modelSetupVisible(thinking, false, true)).toBe(false);
		expect(modelSetupVisible(thinking, true, true)).toBe(true);
	});

	it("uses live model names, and never marks a different live model as the recorded fallback", () => {
		expect(composerModel([selected, swapped], live, null)).toMatchObject({ model: { name: "GPT-6 Luna" }, fallback: { from: primary } });
		expect(composerModel([selected, swapped], { ...live, id: "different" }, null).fallback).toBeNull();
	});

	it("shows the saved fallback without needing a running omp", () => {
		expect(composerModel([selected, swapped], undefined, null)).toMatchObject({ model: { provider: live.provider, id: live.id }, fallback: { from: primary } });
	});
});

describe("provider fallback content", () => {
	it("uses explicit from/to content and rejects incomplete or unchanged models", () => {
		expect(providerFallback(providerBlock)).toEqual({ from: "claude-fable-5", to: "claude-opus-5-5", source: "provider" });
		expect(providerFallback({ ...providerBlock, to: providerBlock.from })).toBeNull();
		expect(providerFallback({ type: "fallback" } as FallbackContent)).toBeNull();
	});

	it("keeps the selected model available to the picker when a different model serves the reply", () => {
		const configured: WireModel = { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", contextWindow: 100000 };
		const result = composerModel([], configured, message({ content: [providerBlock] }));
		expect(result.model).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
		expect(result.selectedModel).toBe(configured);
		expect(result.selectedModel?.id).not.toBe(result.model?.id);
	});

	it("drops an old provider fallback as soon as live selection changes within the same provider", () => {
		const configured: WireModel = { provider: "anthropic", id: "claude-new-selection", name: "New selection", contextWindow: 100000 };
		const result = composerModel([entry(message({ content: [providerBlock] }))], configured, null);
		expect(result.model).toBe(configured);
		expect(result.selectedModel).toBe(configured);
		expect(result.fallback).toBeNull();
	});

	it("shows the serving model for a streamed or saved response, then clears on an ordinary response", () => {
		const response = message({ content: [providerBlock] });
		const configured: WireModel = { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", contextWindow: 100000 };
		for (const result of [composerModel([], configured, response), composerModel([entry(response)], configured, null)]) {
			expect(result).toMatchObject({ model: { provider: "anthropic", id: "claude-opus-5-5" }, fallback: { source: "provider" } });
		}
		expect(composerModel([entry(response)], configured, message()).fallback).toBeNull();
		expect(composerModel([entry(response), change("manual", target, false)], live, null).fallback).toBeNull();
	});
});
