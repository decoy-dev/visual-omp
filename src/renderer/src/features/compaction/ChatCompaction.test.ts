// @vitest-environment happy-dom
import { act, createElement, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SettingInfo } from "@shared/contracts/config";
import type { SessionController, SessionView } from "../../state/session";
import "../../i18n";

const fake = vi.hoisted(() => ({ settings: null as ReadonlyMap<string, SettingInfo> | null, failed: false, retry: vi.fn(), invoke: vi.fn(async () => undefined) }));
vi.mock("./settingsCache", () => ({ useCompactionSettings: () => ({ settings: fake.settings, failed: fake.failed, retry: fake.retry }) }));
vi.mock("../session-tools/model", () => ({ useChatModels: () => ({ models: [{ selector: "fixture/preview", provider: "fixture", id: "preview", name: "Preview", kind: "chat", contextWindow: 1_000_000, maxOutputTokens: 1_000, reasoning: false, thinkingLevels: [], vision: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], error: null }) }));
import { ChatCompaction } from "./ChatCompaction";

let container: HTMLDivElement;
let root: Root;
let view: SessionView;
const session = { projectPath: "/project", subscribe: () => () => {}, getSnapshot: () => view, send: vi.fn() } as unknown as SessionController;
const settings = (values: Record<string, unknown>) => new Map(Object.entries(values).map(([key, value]) => [key, { key, value } as SettingInfo]));

async function render(): Promise<void> {
	await act(async () => { root.render(createElement(Suspense, { fallback: null }, createElement(ChatCompaction, { session }))); });
}
const button = (label: string) => [...container.querySelectorAll("button")].find(element => element.textContent === label);
const slider = () => container.querySelector<HTMLElement>('[role="slider"]')!;
async function key(name: string): Promise<void> {
	await act(async () => { slider().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })); });
}
function withWindow(contextWindow: number, compactAt: number | null = null): SessionView {
	return {
		readOnly: false,
		host: { hostId: "host", generation: 3, sessionId: "session-a", phase: "live", compactAt },
		guest: { state: { model: { provider: "fixture", id: "preview" }, contextUsage: { tokens: 7_500, contextWindow, percent: 1 } } },
	} as unknown as SessionView;
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.assign(window, { vomp: { invoke: fake.invoke } });
	fake.invoke.mockClear();
	fake.retry.mockClear();
	fake.settings = settings({ "compaction.enabled": true });
	fake.failed = false;
	view = withWindow(1_000_000);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

it("marks equal parts of the window and reports omp's default point right away", async () => {
	await render();
	expect(slider().getAttribute("aria-valuemax")).toBe("1000000");
	// Ten ticks of 100K, labelled every 200K.
	expect([...container.querySelectorAll(".font-mono.text-xs.text-fg-faint")].map(label => label.textContent)).toEqual(["200K", "400K", "600K", "800K", "1M"]);
	expect(container.textContent).toContain("Default: 850K");
	expect(container.textContent).toContain("omp summarizes this chat at 850K tokens, from your omp settings.");
	expect(button("Save")!.disabled).toBe(true);
	expect(button("Use default")).toBeUndefined();
});

it("reaches every tick of a 272K window with the keyboard", async () => {
	view = withWindow(272_000);
	await render();
	await key("Home");
	expect(slider().getAttribute("aria-valuenow")).toBe("34000");
	for (let press = 0; press < 4; press++) await key("ArrowRight");
	expect(slider().getAttribute("aria-valuenow")).toBe("68000");
	await key("End");
	expect(slider().getAttribute("aria-valuenow")).toBe("272000");
	await act(async () => button("Save")!.click());
	expect(fake.invoke).toHaveBeenCalledWith("host:setCompactAt", "host", 3, "session-a", 272_000);
});

it("drops an unsaved move with Cancel and keeps the saved point", async () => {
	view = withWindow(1_000_000, 400_000);
	await render();
	expect(container.textContent).toContain("omp summarizes this chat when its context reaches 400K tokens.");
	await key("ArrowRight");
	expect(container.textContent).toContain("425K");
	await act(async () => button("Cancel")!.click());
	expect(fake.invoke).not.toHaveBeenCalled();
	expect(slider().getAttribute("aria-valuenow")).toBe("400000");
	expect(button("Cancel")).toBeUndefined();
	await act(async () => button("Use default")!.click());
	expect(fake.invoke).toHaveBeenCalledWith("host:setCompactAt", "host", 3, "session-a", null);
});

it("waits for omp's settings, and says when they could not be read", async () => {
	fake.settings = null;
	await render();
	expect(container.textContent).toContain("Reading your omp settings…");
	expect(container.textContent).not.toContain("summarizes this chat at");
	fake.failed = true;
	await render();
	expect(container.textContent).toContain("Couldn't read your omp settings, so the default point is unknown.");
	await act(async () => button("Try again")!.click());
	expect(fake.retry).toHaveBeenCalledOnce();
	fake.settings = settings({ "compaction.enabled": true });
	await render();
	expect(container.textContent).toContain("omp summarizes this chat at 850K tokens, from your omp settings. Couldn't refresh your omp settings, so this uses the last ones read.");
});
