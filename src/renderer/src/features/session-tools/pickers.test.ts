// @vitest-environment happy-dom
import type { ModelInfo } from "@shared/contracts/config";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { SessionController } from "../../state/session";
import { TooltipProvider } from "../../ui/Tooltip";
import { ModelButton, ModelList, PermissionMenu, type ModelListProps } from "./pickers";

const fake = vi.hoisted(() => ({
	models: [] as ModelInfo[] | null, error: null as string | null,
	entries: [] as SessionEntry[], model: null as ModelInfo | null, stream: null as AssistantMessage | null,
	readOnly: false, switch: vi.fn(), toast: vi.fn(), command: vi.fn(),
}));
vi.mock("./model", () => ({ useChatModels: () => ({ models: fake.models, error: fake.error }), switchModel: (...args: unknown[]) => fake.switch(...args) }));
vi.mock("./approval", () => ({ useApprovalMode: () => ({ mode: "yolo", rawMode: "yolo", supportedModes: ["always-ask", "write", "yolo"], loaded: true, error: null }) }));
vi.mock("./status", () => ({ useSessionView: () => ({ readOnly: fake.readOnly, guest: { state: { model: fake.model }, stream: fake.stream } }), useOmpScreen: () => ({ status: null }) }));
vi.mock("../../chat/branch", () => ({ useDisplayedEntries: () => fake.entries }));
vi.mock("../../registry/commands", () => ({ getCommand: () => undefined }));
// Vitest hoists this mock before static imports initialize; load the real primitive modules in its factory.
vi.mock("../../state/app", () => ({ useApp: { getState: () => ({}) } }));
vi.mock("@/ui", async () => ({
	...await import("../../ui/Input"), ...await import("../../ui/Popover"), ...await import("../../ui/Tooltip"),
	...await import("../../ui/Button"), ...await import("../../ui/Spinner"), ...await import("../../ui/cn"),
	...await import("../../ui/Menu"),
	toast: (...args: unknown[]) => fake.toast(...args),
}));

function model(id: string, name: string, provider = "anthropic"): ModelInfo {
	return { id, name, provider, selector: `${provider}/${id}`, kind: "chat", contextWindow: 200000, maxOutputTokens: null, reasoning: true, thinkingLevels: [], vision: true, cost: null };
}
const opus55 = model("claude-opus-5-5", "Claude Opus 5.5");
const opus5 = model("claude-opus-5", "Claude Opus 5");
const opus46 = model("claude-opus-4-6", "Claude Opus 4.6");
const sonnet = model("claude-sonnet-5", "Claude Sonnet 5");
const sonnet46 = model("claude-sonnet-4-6", "Claude Sonnet 4.6");
const custom = model("workhorse-42", "Workhorse 42", "local");
const session = { tabId: "chat", projectPath: "/project", getSnapshot: () => ({ readOnly: fake.readOnly }) } as SessionController;
let root: Root;
let element: HTMLDivElement;
let props: ModelListProps;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Element.prototype.scrollIntoView = vi.fn();
	fake.models = [opus55, opus5, opus46, sonnet, sonnet46, custom];
	fake.error = null; fake.entries = []; fake.model = opus55; fake.stream = null; fake.readOnly = false;
	fake.switch.mockReset().mockResolvedValue(true); fake.toast.mockReset();
	props = { projectPath: "/project", current: opus55, session: null, onPick: vi.fn().mockResolvedValue(true), onDone: vi.fn() };
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

it("keeps the permission mode compact with its explanation available from the keyboard", async () => {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(PermissionMenu, { projectPath: "/project" }))));
	const button = element.querySelector<HTMLButtonElement>("button")!;
	expect(button.textContent).toBe("Auto");
	expect(button.getAttribute("aria-label")).toContain("Auto");
	expect(button.getAttribute("aria-description")).toBeTruthy();
	await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
	const selected = document.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')!;
	expect(selected.textContent).toContain(button.getAttribute("aria-description"));
	await act(async () => selected.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	expect(document.querySelector('[role="menu"]')).toBeNull();
});

async function renderList() {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(ModelList, props))));
}
function input(): HTMLInputElement { return document.querySelector('[role="combobox"]')!; }
function active(): HTMLElement | null { return document.getElementById(input().getAttribute("aria-activedescendant") ?? ""); }
function item(label: string): HTMLElement {
	const row = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(node => node.getAttribute("aria-label") === label || node.getAttribute("aria-label")?.startsWith(`${label}, `));
	if (!row) throw new Error(`Missing tree item ${label}`);
	return row;
}
async function click(label: string) {
	await act(async () => item(label).querySelector<HTMLElement>("[data-model-row]")!.click());
}
async function key(value: string) {
	await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}
async function search(value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
		input().dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("shared model tree interactions", () => {
	it.each([null, session])("opens the selected branch for Home/chat consumer %s and chooses only an explicit version", async consumer => {
		props.session = consumer;
		await renderList();
		expect(input().getAttribute("aria-haspopup")).toBe("tree");
		expect(active()).toBe(item(opus55.name));
		expect(item(opus55.name).getAttribute("aria-selected")).toBe("true");
		expect(item("Claude Sonnet").getAttribute("aria-expanded")).toBe("false");
		await click("Claude Sonnet");
		expect(props.onPick).not.toHaveBeenCalled(); expect(props.onDone).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(input());
		expect(item("Claude Sonnet").getAttribute("aria-expanded")).toBe("true");
		await click(sonnet46.name);
		expect(props.onPick).toHaveBeenCalledExactlyOnceWith(sonnet46); expect(props.onDone).toHaveBeenCalledOnce();
	});

	it("supports Up/Down and Left/Right without switching when a group expands", async () => {
		await renderList();
		await key("ArrowLeft"); expect(active()).toBe(item("Claude Opus"));
		await key("ArrowLeft"); expect(item("Claude Opus").getAttribute("aria-expanded")).toBe("false");
		await key("Enter"); expect(item("Claude Opus").getAttribute("aria-expanded")).toBe("true");
		expect(props.onPick).not.toHaveBeenCalled();
		await key("ArrowRight"); expect(active()).toBe(item(opus55.name));
		await key("ArrowDown"); expect(active()).toBe(item(opus5.name));
		await key("ArrowUp"); expect(active()).toBe(item(opus55.name));
		await key("ArrowDown"); await key("Enter");
		expect(props.onPick).toHaveBeenCalledExactlyOnceWith(opus5);
	});

	it("supports Home and End across the visible tree and filtered descendants", async () => {
		await renderList();
		await key("End"); expect(active()).toBe(item("local"));
		await key("Home"); expect(active()).toBe(item("anthropic"));
		await search("opus");
		await key("End"); expect(active()).toBe(item(opus46.name));
		await key("Home"); expect(active()).toBe(item("anthropic"));
		expect(props.onPick).not.toHaveBeenCalled();
	});

	it("restores pre-search expanded and collapsed branches independently of search disclosures", async () => {
		await renderList();
		await click("Claude Sonnet");
		await click("Claude Opus");
		await search("opus");
		expect(item("Claude Opus").getAttribute("aria-expanded")).toBe("true");
		await click("Claude Opus");
		expect(item("Claude Opus").getAttribute("aria-expanded")).toBe("false");
		await search("sonnet");
		expect(item("Claude Sonnet").getAttribute("aria-expanded")).toBe("true");
		await search("");
		expect(item("Claude Opus").getAttribute("aria-expanded")).toBe("false");
		expect(item("Claude Sonnet").getAttribute("aria-expanded")).toBe("true");
		expect(active()).toBe(item("anthropic"));
		await key("Enter"); expect(props.onPick).not.toHaveBeenCalled();
	});

	it("cannot choose an index-replacement model after a live catalog removes the active and current leaves", async () => {
		await renderList(); await key("ArrowDown");
		expect(active()).toBe(item(opus5.name));
		const replacement = model("replacement-99", "Replacement 99");
		fake.models = [replacement, opus46];
		await renderList();
		expect(active()).toBe(item("anthropic"));
		await key("Enter"); expect(props.onPick).not.toHaveBeenCalled();
		await search("replacement-99"); await key("ArrowDown"); await key("Enter");
		expect(props.onPick).toHaveBeenCalledExactlyOnceWith(replacement);
	});

	it("never submits a hidden leaf after collapsing it, and restores current selection after searching", async () => {
		await renderList();
		await click("Claude Opus"); await key("Enter");
		expect(props.onPick).not.toHaveBeenCalled();
		await search("workhorse-42");
		expect(item("local").getAttribute("aria-expanded")).toBe("true");
		expect(active()).toBe(item("local"));
		await key("Enter"); expect(props.onPick).not.toHaveBeenCalled();
		await search("");
		expect(active()).toBe(item(opus55.name));
		expect(item("Claude Opus").getAttribute("aria-expanded")).toBe("true");
		await key("Enter"); expect(props.onPick).not.toHaveBeenCalled(); expect(props.onDone).toHaveBeenCalledOnce();
	});

	it("searches provider and full ids, resets active identity, and never selects a stale result", async () => {
		await renderList(); await search("local");
		await key("ArrowDown"); expect(active()).toBe(item(custom.name));
		await search("anthropic opus-4-6");
		expect(active()).toBe(item("anthropic"));
		expect(item("Claude Opus").getAttribute("aria-expanded")).toBe("true");
		await key("Enter"); expect(props.onPick).not.toHaveBeenCalled();
		await key("ArrowDown"); await key("ArrowDown"); await key("Enter");
		expect(props.onPick).toHaveBeenCalledExactlyOnceWith(opus46);
		await search("no results"); expect(active()).toBeNull(); await key("Enter");
		expect(props.onPick).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain("No models match");
	});

	it("keeps busy/refused/error choices open, blocks repeated submissions and permits retry", async () => {
		const pending = Promise.withResolvers<boolean>();
		props.onPick = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("Switch unavailable")).mockResolvedValueOnce(true);
		await renderList(); await click(opus5.name);
		expect(document.querySelector('[role="tree"]')?.getAttribute("aria-busy")).toBe("true");
		await click(opus46.name); await key("Enter"); expect(props.onPick).toHaveBeenCalledOnce();
		await act(async () => pending.resolve(false));
		expect(props.onDone).not.toHaveBeenCalled();
		expect(document.querySelector('[role="tree"]')?.getAttribute("aria-busy")).toBe("false");
		await click(opus46.name); expect(props.onDone).not.toHaveBeenCalled();
		await click(opus46.name); expect(fake.toast).toHaveBeenCalledWith({ tone: "err", message: "Switch unavailable" });
		await click(opus46.name); expect(props.onDone).toHaveBeenCalledOnce();
	});

	it("blocks repeated pointer and keyboard submissions synchronously before React renders busy state", async () => {
		const pending = Promise.withResolvers<boolean>();
		props.onPick = vi.fn().mockReturnValue(pending.promise);
		await renderList();
		await act(async () => {
			item(opus5.name).querySelector<HTMLElement>("[data-model-row]")!.click();
			item(opus46.name).querySelector<HTMLElement>("[data-model-row]")!.click();
			input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});
		expect(props.onPick).toHaveBeenCalledExactlyOnceWith(opus5);
		await act(async () => pending.resolve(false));
		expect(props.onDone).not.toHaveBeenCalled();
	});

	it("keeps the in-flight choice through callback rerenders and invokes the latest completion callback", async () => {
		const pending = Promise.withResolvers<boolean>();
		const initialPick = vi.fn().mockReturnValue(pending.promise);
		const initialDone = vi.fn();
		props = { ...props, onPick: initialPick, onDone: initialDone };
		await renderList(); await click(opus5.name);
		const latestPick = vi.fn().mockResolvedValue(true);
		const latestDone = vi.fn();
		props = { ...props, onPick: latestPick, onDone: latestDone };
		await renderList(); await click(opus46.name);
		expect(initialPick).toHaveBeenCalledExactlyOnceWith(opus5);
		expect(latestPick).not.toHaveBeenCalled();
		await act(async () => pending.resolve(true));
		expect(initialDone).not.toHaveBeenCalled();
		expect(latestDone).toHaveBeenCalledOnce();
	});

	it("does not invoke completion after a pending choice's picker unmounts", async () => {
		const pending = Promise.withResolvers<boolean>();
		props.onPick = vi.fn().mockReturnValue(pending.promise);
		await renderList(); await click(opus5.name);
		await act(async () => root.render(null));
		await act(async () => pending.resolve(true));
		expect(props.onDone).not.toHaveBeenCalled();
	});

	it("leaves unknown singleton models directly selectable and retains capability metadata", async () => {
		await renderList(); await click("local");
		expect(item(custom.name).getAttribute("aria-level")).toBe("2");
		expect(item(custom.name).querySelector('[aria-label="Reads images"]')).not.toBeNull();
		expect(item(custom.name).textContent).toContain("200K");
		expect(item(custom.name).getAttribute("aria-description")).toBe("Reads images, Supports thinking levels, Context window: 200K");
		expect(item(custom.name).getAttribute("aria-label")).toContain(custom.id);
		await click(custom.name); expect(props.onPick).toHaveBeenCalledExactlyOnceWith(custom);
	});

	it("exposes the full model id and capabilities when a selector is an opaque alias", async () => {
		const aliased = { ...custom, selector: "workhorse-alias" };
		fake.models = [aliased];
		props.current = null;
		await renderList(); await click("local");
		expect(item(custom.name).getAttribute("aria-label")).toContain("workhorse-alias, local, workhorse-42");
		expect(item(custom.name).getAttribute("aria-description")).toContain("Supports thinking levels");
		await click(custom.name); expect(props.onPick).toHaveBeenCalledExactlyOnceWith(aliased);
	});

	it("handles loading, catalog failure and no available models", async () => {
		fake.models = null; await renderList(); expect(document.body.textContent).toContain("Loading models");
		fake.error = "Catalog unavailable"; await renderList(); expect(document.body.textContent).toContain("Catalog unavailable");
		fake.error = null; fake.models = []; await renderList(); expect(document.body.textContent).toContain("omp has no models yet");
	});
});

it("keeps selected and serving fallback identities separate in the chat consumer, and Escape closes the parent", async () => {
	fake.model = opus5;
	fake.stream = { role: "assistant", provider: "anthropic", model: opus5.id, content: [{ type: "fallback", from: { model: opus5.id }, to: { model: opus55.id } }], timestamp: 0 } as AssistantMessage;
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(ModelButton, { session }))));
	const button = document.querySelector<HTMLButtonElement>('button[aria-label^="Choose model."]')!;
	expect(button.textContent).toContain("Fallback");
	await act(async () => button.click());
	expect(item(opus5.name).getAttribute("aria-selected")).toBe("true");
	expect(item(opus55.name).getAttribute("aria-selected")).toBe("false");
	fake.switch.mockResolvedValueOnce(false);
	await click(opus55.name); expect(fake.switch).toHaveBeenCalledExactlyOnceWith(session, opus55);
	expect(document.querySelector('[role="tree"]')).not.toBeNull();
	await key("Escape"); expect(document.querySelector('[role="tree"]')).toBeNull();
});

it("names a saved chat's recorded model like a live chat, and keeps an uncatalogued selector readable", async () => {
	fake.model = null;
	fake.entries = [{ type: "model_change", id: "m1", parentId: null, timestamp: "", model: "anthropic/claude-opus-5" } as SessionEntry];
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(ModelButton, { session }))));
	const button = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Choose model."]')!;
	expect(button().getAttribute("aria-label")).toBe("Choose model. Current: Claude Opus 5");
	expect(button().textContent).not.toContain("anthropic/claude-opus-5");
	fake.entries = [{ type: "model_change", id: "m2", parentId: null, timestamp: "", model: "local/retired-model" } as SessionEntry];
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(ModelButton, { session }))));
	expect(button().getAttribute("aria-label")).toBe("Choose model. Current: local/retired-model");
});

it("lets real Radix close the parent on Escape while the model search has a query", async () => {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(ModelButton, { session }))));
	const button = document.querySelector<HTMLButtonElement>('button[aria-label^="Choose model."]')!;
	await act(async () => button.click());
	await search("opus-4-6");
	expect(input().value).toBe("opus-4-6");
	await key("Escape");
	expect(document.querySelector('[role="tree"]')).toBeNull();
	expect(fake.switch).not.toHaveBeenCalled();
});
