// @vitest-environment happy-dom
import type { ModelInfo } from "@shared/contracts/config";
import { act, createElement as e } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { thinkingChoices, useChatModels } from "./model";
import { ModelList } from "./pickers";
import { TooltipProvider } from "../../ui/Tooltip";

const bridge = vi.hoisted(() => {
	const invoke = vi.fn();
	const listeners = new Map<string, Set<() => void>>();
	Object.defineProperty(window, "vomp", { configurable: true, value: {
		invoke,
		on: (channel: string, listener: () => void) => {
			const subscribers = listeners.get(channel) ?? new Set();
			subscribers.add(listener); listeners.set(channel, subscribers);
			return () => subscribers.delete(listener);
		},
	} });
	return { invoke, listeners };
});

const oldModel: ModelInfo = {
	provider: "anthropic", id: "claude-fable-5-2", selector: "anthropic/claude-fable-5-2",
	name: "Claude Fable 5.2", kind: "chat", contextWindow: 200_000, maxOutputTokens: 32_000,
	reasoning: false, thinkingLevels: [], vision: false, pricingStatus: "unknown", cost: null,
};
const currentModel: ModelInfo = {
	...oldModel, contextWindow: 1_000_000, reasoning: true, thinkingLevels: ["low", "high", "max"], vision: true,
	pricingStatus: "fixed", cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, longContext: null },
};
let root: Root;
let element: HTMLDivElement;
const changed = async (channel = "omp:status") => {
	await act(async () => { for (const listener of bridge.listeners.get(channel) ?? []) listener(); });
};
function Details({ cwd }: { cwd: string }) {
	const { models, error } = useChatModels(cwd);
	return e("output", null, JSON.stringify({ model: models?.[0], efforts: thinkingChoices(models?.[0]), error }));
}
async function render(cwd = "/fixture/project") {
	await act(async () => root.render(e(TooltipProvider, null,
		e(ModelList, { projectPath: cwd, current: oldModel, onPick: async () => true, onDone: () => {}, session: null }),
		e(Details, { cwd }),
	)));
}
beforeAll(async () => { await i18n.loadNamespaces(["session", "settings"]); });
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Element.prototype.scrollIntoView = vi.fn();
	bridge.invoke.mockReset();
	await changed();
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

describe("mounted model catalogs", () => {
	it("refreshes an already-open picker and its shared metadata after an installed version change", async () => {
		bridge.invoke.mockResolvedValueOnce([oldModel]).mockResolvedValueOnce([currentModel]);
		await render();
		expect(bridge.invoke).toHaveBeenCalledTimes(1);
		expect(element.querySelector('[aria-label="Reads images"]')).toBeNull();
		expect(element.querySelector('[aria-label="Supports thinking levels"]')).toBeNull();
		expect(element.querySelector("output")?.textContent).toContain('"efforts":[]');
		await changed();
		expect(bridge.invoke).toHaveBeenCalledTimes(2);
		expect(element.querySelector('[aria-label="Reads images"]')).not.toBeNull();
		expect(element.querySelector('[aria-label="Supports thinking levels"]')).not.toBeNull();
		expect(element.textContent).toContain("1M");
		const details = JSON.parse(element.querySelector("output")!.textContent!);
		expect(details).toMatchObject({
			model: { contextWindow: 1_000_000, cost: { input: 8, output: 40, cacheRead: 0.2 } },
			efforts: ["off", "auto", "low", "high", "max"], error: null,
		});
	});

	it.each(["resolve", "reject"] as const)("ignores an obsolete catalog that later %ss after omp changes", async outcome => {
		const stale = Promise.withResolvers<ModelInfo[]>();
		bridge.invoke.mockReturnValueOnce(stale.promise).mockResolvedValueOnce([currentModel]);
		await render();
		await changed();
		bridge.invoke.mockResolvedValue([currentModel]);
		await act(async () => {
			if (outcome === "resolve") stale.resolve([oldModel]);
			else stale.reject(new Error("Old executable stopped"));
		});
		expect(JSON.parse(element.querySelector("output")!.textContent!)).toMatchObject({ model: { reasoning: true, cost: { input: 8 } }, error: null });
		await render("/fixture/other");
		await render();
		expect(JSON.parse(element.querySelector("output")!.textContent!)).toMatchObject({ model: { reasoning: true }, error: null });
	});

	it("refreshes mounted readers after a credential change and retries a failed read", async () => {
		bridge.invoke.mockRejectedValueOnce(new Error("Catalog unavailable")).mockResolvedValueOnce([currentModel]);
		await render();
		expect(element.querySelector("output")?.textContent).toContain("Catalog unavailable");
		await changed("providers:changed");
		expect(bridge.invoke).toHaveBeenCalledTimes(2);
		expect(JSON.parse(element.querySelector("output")!.textContent!)).toMatchObject({ model: { reasoning: true }, error: null });
	});
});
