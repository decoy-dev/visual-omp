// @vitest-environment happy-dom
import { act, createElement as e, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigSnapshot, JsonValue, ModelInfo, ModelRolesState, SettingInfo } from "@shared/contracts/config";
import type * as Ui from "@/ui";
import { TooltipProvider } from "@/ui";
import { i18n } from "../../../i18n";
import { ModelsSection } from "./ModelsSection";

const fake = vi.hoisted(() => ({
	invoke: vi.fn(), chains: {} as Record<string, JsonValue>, fail: false,
	rawChains: undefined as JsonValue | undefined, projectChains: null as Record<string, JsonValue> | null,
	globalBehavior: {} as Record<string, JsonValue>, projectBehavior: {} as Record<string, JsonValue>,
	fallbackOnChoices: ["any", "usage-limit"],
	catalog: [] as ModelInfo[], listeners: new Map<string, Set<() => void>>(),
}));
// Keep the real IconButton and its focus behavior, but omit Radix tooltip trees from each editor update.
// Button imports Tooltip directly, so mocking only the UI barrel would leave those trees mounted.
vi.mock("@/ui/Tooltip", () => ({
	Tooltip: ({ children }: PropsWithChildren) => children,
	TooltipProvider: ({ children }: PropsWithChildren) => children,
}));
// Use native selects for deterministic form events; the headless check exercises actual Radix menus.
vi.mock("@/ui", async () => {
	const actual = await vi.importActual<typeof Ui>("@/ui");
	return {
		...actual,
		Select: ({ children, value, onValueChange, disabled, "aria-label": label }: PropsWithChildren<{ value: string; onValueChange(value: string): void; disabled?: boolean; "aria-label"?: string }>) => e("select", { value, disabled, "aria-label": label, onChange: (event: { currentTarget: HTMLSelectElement }) => onValueChange(event.currentTarget.value) }, children),
		SelectItem: ({ children, value }: PropsWithChildren<{ value: string }>) => e("option", { value }, children),
		SelectGroup: ({ children }: PropsWithChildren) => e("optgroup", { label: "Models" }, children),
		SelectLabel: () => null, SelectSeparator: () => null,
		Expand: ({ children, open }: PropsWithChildren<{ open: boolean }>) => open ? e("div", null, children) : null,
		toast: vi.fn(),
	};
});
vi.mock("./Presets", () => ({ PresetList: () => null, SavePresetDialog: () => null }));
vi.mock("./CompactionLimits", () => ({ CompactionLimits: () => null }));

const models: ModelInfo[] = ["openai-codex/gpt-6-luna", "test/second", "test/third"].map(selector => ({ selector, provider: selector.split("/")[0]!, id: selector.split("/")[1]!, name: selector.split("/")[1]!, kind: "chat", contextWindow: 200_000, maxOutputTokens: null, reasoning: true, thinkingLevels: ["low", "high"], vision: false, cost: null }));
const roles: ModelRolesState = { cwd: "/fixture/project", storage: "project", storageSource: "global", defaultThinkingLevel: "high", roles: ["default", "plan", "image"].map(id => ({ id, name: id === "default" ? "Default" : id, builtIn: true, section: id === "image" ? "kind" : "chat", acceptsKinds: id === "image" ? ["image"] : ["chat"], color: null, hidden: false, inCycle: false, value: "test/third:high", model: "test/third", thinking: "high", source: "global", globalValue: "test/third:high", projectValue: null })) };
const defaults: Record<string, JsonValue> = { "retry.modelFallback": true, "retry.fallbackOn": "any", "retry.fallbackRevertPolicy": "cooldown-expiry" };
const setting = (key: string, value: JsonValue): SettingInfo => ({ key, value, namespace: "retry", type: typeof value === "boolean" ? "boolean" : typeof value === "string" ? "enum" : "record", description: "", enumValues: null, defaultValue: defaults[key] ?? {}, redacted: false, modified: true, source: "global", globalValue: value, projectValue: null });
function behaviorSetting(key: string): SettingInfo {
	const global = fake.globalBehavior[key] ?? null;
	const project = fake.projectBehavior[key] ?? null;
	return { ...setting(key, project ?? global ?? defaults[key]!), globalValue: global, projectValue: project, source: project !== null ? "project" : global !== null ? "global" : "default", enumValues: key === "retry.fallbackOn" ? fake.fallbackOnChoices : key === "retry.fallbackRevertPolicy" ? ["cooldown-expiry", "never"] : null };
}
function snapshot(): ConfigSnapshot {
	const global = fake.rawChains === undefined ? fake.chains : fake.rawChains;
	const effective = fake.rawChains === undefined ? { ...fake.chains, ...fake.projectChains } : global;
	return {
		cwd: "/fixture/project", agentDir: "/fixture/agent", globalFile: "/fixture/global.yml", projectFile: "/fixture/project/.omp/config.yml",
		settings: [{ ...setting("retry.fallbackChains", effective), globalValue: global, projectValue: fake.projectChains, source: fake.projectChains ? "project" : "global" }, ...Object.keys(defaults).map(behaviorSetting)],
	};
}
let root: Root;
let element: HTMLDivElement;
const click = async (label: string) => {
	const button = element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? [...element.querySelectorAll("button")].find(button => button.textContent === label)!;
	await act(async () => button.click());
};
const select = async (label: string, value: string) => {
	const select = element.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
	await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
};
const render = async (scope: "global" | "project" = "global") => {
	await act(async () => root.render(e(TooltipProvider, { children: e(ModelsSection, { projectPath: "/fixture/project", scope, setScope: () => {}, props: {} }) })));
};
beforeAll(async () => { await i18n.loadNamespaces("settings"); });
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.chains = { default: ["openai-codex/gpt-6-luna"], "test/*": ["backup/*"], broken: [23] };
	fake.fail = false; fake.rawChains = undefined; fake.projectChains = null;
	fake.globalBehavior = { ...defaults }; fake.projectBehavior = {}; fake.fallbackOnChoices = ["any", "usage-limit"];
	fake.invoke.mockReset();
	fake.catalog = models; fake.listeners.clear();
	fake.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
		if (channel === "config:list") return snapshot();
		if (channel === "config:roles") return roles;
		if (channel === "config:models") return fake.catalog;
		if (channel === "config:presets") return [];
		if (channel === "config:roles:fallbacks") {
			if (fake.fail) throw new Error("Write refused");
			const [role, chain, options] = args as [string, string[] | null, { scope: string }];
			const target = options.scope === "project" ? (fake.projectChains ??= {}) : fake.chains;
			if (chain !== null && chain.length === 0) delete target[role];
			else target[role] = chain ?? [];
			return { setting: snapshot().settings[0], shadowedBy: null };
		}
		if (channel === "config:set") {
			const [key, value, scope] = args as [string, JsonValue, string];
			(scope === "project" ? fake.projectBehavior : fake.globalBehavior)[key] = value;
			return { setting: behaviorSetting(key), shadowedBy: null };
		}
		return undefined;
	});
	Object.assign(window, { vomp: { invoke: fake.invoke, on: (channel: string, listener: () => void) => {
		const listeners = fake.listeners.get(channel) ?? new Set(); listeners.add(listener); fake.listeners.set(channel, listeners);
		return () => listeners.delete(listener);
	}, platform: "darwin" } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

describe("Settings model fallback editor", () => {
	it("shows the owner's existing Default chain first and inherited thinking without changing it", async () => {
		await render();
		expect(element.querySelector("h3")?.textContent).toBe("Default");
		expect(element.querySelector<HTMLSelectElement>('select[aria-label="Fallback 1 model for Default"]')?.value).toBe("openai-codex/gpt-6-luna");
		expect(element.querySelector<HTMLSelectElement>('select[aria-label="Fallback 1 thinking for Default"]')?.value).toBe("inherit");
		expect(element.textContent).toContain("No fallback models");
		expect(element.textContent).toContain('"test/*"');
		expect(fake.invoke.mock.calls.some(call => call[0] === "config:roles:fallbacks")).toBe(false);
	});
	it("adds, deduplicates, reorders, specializes effort and removes models, then writes the exact target chain", async () => {
		fake.projectChains = { default: ["openai-codex/gpt-6-luna"] };
		await render("project");
		await select("Add a fallback model for Default", "test/second");
		await select("Add a fallback model for Default", "test/second");
		await click("Move fallback 2 up for Default");
		await select("Fallback 1 thinking for Default", "high");
		await select("Add a fallback model for Default", "test/third");
		await click("Remove fallback 2 for Default");
		await click("Save roles");
		expect(fake.invoke).toHaveBeenCalledWith("config:roles:fallbacks", "default", ["test/second:high", "test/third"], { cwd: "/fixture/project", scope: "project" });
		expect(fake.projectChains.default).toEqual(["test/second:high", "test/third"]);
		expect(fake.chains.default).toEqual(["openai-codex/gpt-6-luna"]);
		expect(fake.chains["test/*"]).toEqual(["backup/*"]);
		expect(fake.chains.broken).toEqual([23]);
		expect(fake.invoke.mock.calls.some(call => call[0] === "config:roles:set")).toBe(false);
	});
	it("edits global chain values independently of the differing effective project chain", async () => {
		fake.projectChains = { default: ["test/second"] };
		await render();
		expect(element.querySelector<HTMLSelectElement>('select[aria-label="Fallback 1 model for Default"]')?.value).toBe("openai-codex/gpt-6-luna");
		expect(element.textContent).toContain("Currently effective chain:");
		await select("Fallback 1 thinking for Default", "high"); await click("Save roles");
		expect(fake.chains.default).toEqual(["openai-codex/gpt-6-luna:high"]);
		expect(fake.projectChains.default).toEqual(["test/second"]);
		await click("Restore fallback defaults for Default"); await click("Save roles");
		expect(fake.chains.default).toBeUndefined();
		expect(fake.projectChains.default).toEqual(["test/second"]);
	});
	it("shows inherited global chains read-only and creates only the requested project override", async () => {
		await render("project");
		expect(element.querySelector('select[aria-label="Fallback 1 model for Default"]')).toBeNull();
		expect(element.textContent).toContain("Currently effective chain:");
		expect(element.querySelector('button[aria-label="Restore fallback defaults for Default"]')).toBeNull();
		await select("Add a fallback model for Default", "test/second"); await click("Save roles");
		expect(fake.projectChains).toEqual({ default: ["test/second"] });
		expect(fake.chains.default).toEqual(["openai-codex/gpt-6-luna"]);
		await click("Restore fallback defaults for Default"); await click("Save roles");
		expect(fake.projectChains).toEqual({});
		expect(element.querySelector('select[aria-label="Fallback 1 model for Default"]')).toBeNull();
		expect(element.textContent).toContain("openai-codex/gpt-6-luna");
	});
	it("explicitly disables Default inheritance for a chat role and restores it by removing the project key", async () => {
		await render("project");
		await click("Use no fallback models for plan"); await click("Save roles");
		expect(fake.projectChains).toEqual({ plan: [] });
		expect(element.textContent).toContain("This role's chain is explicitly empty");
		await click("Restore fallback defaults for plan"); await click("Save roles");
		expect(fake.projectChains).toEqual({});
		expect(fake.chains.default).toEqual(["openai-codex/gpt-6-luna"]);
	});
	it("replaces a model with a bare pick and deduplicates at the edited position", async () => {
		fake.chains.default = ["test/second", "openai-codex/gpt-6-luna:high", "test/third"];
		await render(); await select("Fallback 2 model for Default", "test/second"); await click("Save roles");
		expect(fake.chains.default).toEqual(["test/second", "test/third"]);
	});
	it("writes bare thinking on inherit and clears the key when the last model is removed", async () => {
		fake.chains.default = ["test/second:high"];
		await render(); await select("Fallback 1 thinking for Default", "inherit"); await click("Save roles");
		expect(fake.chains.default).toEqual(["test/second"]);
		await click("Remove fallback 1 for Default"); await click("Save roles");
		expect(fake.invoke).toHaveBeenLastCalledWith("config:roles:fallbacks", "default", [], { cwd: "/fixture/project", scope: "global" });
		expect(fake.chains.default).toBeUndefined();
	});
	it("preserves a stored Auto suffix when editing another entry and stores bare inherit when explicitly changed", async () => {
		fake.chains.default = ["test/second:auto"];
		await render();
		expect(element.querySelector<HTMLSelectElement>('select[aria-label="Fallback 1 thinking for Default"]')?.value).toBe("auto");
		await select("Add a fallback model for Default", "test/third"); await click("Save roles");
		expect(fake.chains.default).toEqual(["test/second:auto", "test/third"]);
		await select("Fallback 1 thinking for Default", "inherit"); await click("Save roles");
		expect(fake.chains.default).toEqual(["test/second", "test/third"]);
	});
	it("keeps unknown and malformed role entries read-only while saving a different chain", async () => {
		fake.chains.default = ["unknown/model:future", 23];
		await render();
		expect(element.textContent).toContain("unknown/model:future");
		expect(element.querySelector('select[aria-label="Add a fallback model for Default"]')).toBeNull();
		await select("Add a fallback model for plan", "test/second"); await click("Save roles");
		expect(fake.chains.default).toEqual(["unknown/model:future", 23]);
	});
	it("shows malformed root records read-only and disables chain editing", async () => {
		fake.rawChains = ["unrecognized"];
		await render();
		expect(element.textContent).toContain("unrecognized");
		expect(element.querySelector<HTMLSelectElement>('select[aria-label="Add a fallback model for Default"]')?.disabled).toBe(true);
	});
	it("writes the behavior keys in the selected scope", async () => {
		await render("project"); await click("Switch models when one fails");
		await select("Switch after", "usage-limit"); await select("Return to the main model", "never");
		for (const [key, value] of [["retry.modelFallback", false], ["retry.fallbackOn", "usage-limit"], ["retry.fallbackRevertPolicy", "never"]]) expect(fake.invoke).toHaveBeenCalledWith("config:set", key, value, "project", "/fixture/project");
	});
	it("shows a global enabled switch and the effective project-disabled value independently", async () => {
		fake.projectBehavior["retry.modelFallback"] = false;
		await render();
		expect(element.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
		expect(element.textContent).toContain("Currently effective: Off.");
		await click("Switch models when one fails");
		expect(fake.globalBehavior["retry.modelFallback"]).toBe(false);
		expect(fake.projectBehavior["retry.modelFallback"]).toBe(false);
	});
	it("offers All but usage limits only when omp advertises support", async () => {
		await render();
		expect(element.textContent).not.toContain("All but usage limits");
		fake.fallbackOnChoices = ["any", "usage-limit", "except-usage-limit"];
		await act(async () => { root.unmount(); root = createRoot(element); }); await render();
		expect(element.textContent).toContain("All but usage limits");
		await select("Switch after", "except-usage-limit");
		expect(fake.globalBehavior["retry.fallbackOn"]).toBe("except-usage-limit");
	});
	it("retains a pending chain when saving fails, and Revert discards it", async () => {
		await render(); await select("Add a fallback model for Default", "test/second"); fake.fail = true;
		await click("Save roles");
		expect(element.querySelector<HTMLSelectElement>('select[aria-label="Fallback 2 model for Default"]')?.value).toBe("test/second");
		await click("Revert changes");
		expect(element.querySelector('select[aria-label="Fallback 2 model for Default"]')).toBeNull();
	});
	it("preserves explicit empty kind chains and restores inherited settings without claiming built-in order", async () => {
		fake.chains.image = [];
		await render(); await click("Restore fallback defaults for image"); await click("Save roles");
		expect(fake.chains.image).toBeUndefined();
		await click("Use no fallback models for image"); await click("Save roles");
		expect(fake.chains.image).toEqual([]);
	});
	it.each(["resolve", "reject"] as const)("keeps the installed catalog when an older manual refresh later %ss", async outcome => {
		const stale = Promise.withResolvers<ModelInfo[]>();
		const invoke = fake.invoke.getMockImplementation()!;
		fake.invoke.mockImplementation((channel: string, ...args: unknown[]) =>
			channel === "config:models:refresh" ? stale.promise : invoke(channel, ...args));
		await render();
		await click("Refresh the model list");
		fake.catalog = models.map(model => ({ ...model, name: `Updated ${model.name}` }));
		await act(async () => { for (const listener of fake.listeners.get("omp:status") ?? []) listener(); });
		const chosen = () => element.querySelector<HTMLSelectElement>('select[aria-label="Fallback 1 model for Default"]')?.selectedOptions[0]?.textContent;
		expect(chosen()).toBe("Updated gpt-6-luna");
		await act(async () => {
			if (outcome === "resolve") stale.resolve(models);
			else stale.reject(new Error("Obsolete model refresh failed"));
		});
		expect(chosen()).toBe("Updated gpt-6-luna");
		expect(element.textContent).not.toContain("Obsolete model refresh failed");
	});
});
