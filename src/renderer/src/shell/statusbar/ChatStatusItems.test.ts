// @vitest-environment happy-dom
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import settingsMessages from "../../i18n/en/settings.json";
import type { PaneProps } from "../../registry/slots";
import type { SessionController, SessionView } from "../../state/session";
import { TooltipProvider } from "../../ui";
import type { ThinkingState } from "../../features/session-tools/thinking";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { CacheStatusItem, ContextStatusItem, HelpersStatusItem, ModelStatusItem, QueueStatusItem, ThinkingStatusItem, WorkingStatusItem } from "./ChatStatusItems";

const fake = vi.hoisted(() => ({ snapshot: null as TspHostSnapshot | null, thinking: { configured: "auto", resolved: null, provisional: false } as ThinkingState, models: [{ provider: "fixture", id: "model", name: "Catalog model" }] }));
vi.mock("../../chat/branch", () => ({ useDisplayedEntries: () => [] }));
vi.mock("../../features/session-tools/model", () => ({ useChatModels: () => ({ models: fake.models }) }));
vi.mock("../../features/session-tools/pickers", () => ({ useThinking: () => fake.thinking }));
vi.mock("../../state/tsp/useTsp", () => ({ useTsp: () => ({ snapshot: fake.snapshot }) }));
let root: Root; let element: HTMLDivElement; let view: SessionView;
const session = { projectPath: "/fixture", subscribe: () => () => {}, getSnapshot: () => view } as unknown as SessionController;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	i18n.addResourceBundle("en", "settings", settingsMessages);
	view = { mode: "live", readOnly: false, follow: null, queue: [], working: false, workingSince: null, guest: { phase: "live", state: { contextUsage: { percent: 62.6 }, model: { provider: "fixture", id: "model", name: "Wire model" } }, stream: null, agents: [], progress: new Map(), lifecycle: new Map() } } as unknown as SessionView;
	fake.thinking = { configured: "auto", resolved: null, provisional: false };
	fake.snapshot = null;
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.useRealTimers(); });
async function render(component: ComponentType<PaneProps>, controller: SessionController | null = session) {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(component, { session: controller, projectPath: "/fixture" }))));
}
it("rounds known context use and omits an unavailable percentage", async () => {
	await render(ContextStatusItem); expect(element.textContent).toBe("Context 63%");
	view = { ...view, guest: { ...view.guest!, state: { ...view.guest!.state!, contextUsage: { percent: null } } } } as SessionView;
	await render(ContextStatusItem); expect(element.textContent).toBe("");
});
it("uses the model picker's catalog name and retains the full accessible label", async () => {
	await render(ModelStatusItem); expect(element.textContent).toBe("Catalog model"); expect(element.querySelector('[aria-label="Model: Catalog model"]')).not.toBeNull();
});
it("keeps configured Auto and formats the thinking level with the picker labels", async () => {
	await render(ThinkingStatusItem); expect(element.textContent).toBe("Auto");
	fake.thinking = { configured: "auto", resolved: "low", provisional: false }; await render(ThinkingStatusItem); expect(element.textContent).toBe("Auto · Low");
	expect(element.querySelector('[aria-label="Thinking level: Auto · Low"]')).not.toBeNull();
	expect(element.querySelector(".font-medium.text-fg")?.textContent).toBe(" · Low");
	fake.thinking = { configured: "auto", resolved: null, provisional: true }; await render(ThinkingStatusItem); expect(element.textContent).toBe("Auto · Pending");
	fake.thinking = { configured: "auto", resolved: "high", provisional: true }; await render(ThinkingStatusItem); expect(element.textContent).toBe("Auto · High (provisional)");
	fake.thinking = { configured: "xhigh", resolved: null, provisional: false }; await render(ThinkingStatusItem); expect(element.textContent).toBe("Extra high");
	fake.thinking = { configured: null, resolved: null, provisional: false }; await render(ThinkingStatusItem); expect(element.textContent).toBe("");
});
it("includes the whole composer queue, including a zero count", async () => {
	await render(QueueStatusItem); expect(element.textContent).toBe("0 queued");
	view = { ...view, queue: [{ id: "a", text: "first", images: [] }, { id: "b", text: "second", images: [], error: "rejected" }] };
	await render(QueueStatusItem); expect(element.textContent).toBe("2 queued");
});
it("counts from the working indicator's observed start and omits time for an unknown start", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }); vi.setSystemTime(125_000);
	view = { ...view, working: true, workingSince: 0 };
	await render(WorkingStatusItem); expect(element.textContent).toBe("Working 2m 05s");
	await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(element.textContent).toBe("Working 2m 06s");
	view = { ...view, workingSince: null }; await render(WorkingStatusItem); expect(element.textContent).toBe("Working");
	view = { ...view, working: false }; await render(WorkingStatusItem); expect(element.textContent).toBe("");
});
it("uses the Tasks running-helper rule and excludes idle or stopped helpers", async () => {
	view = { ...view, guest: { ...view.guest!, agents: [{ id: "one", kind: "sub", status: "running", displayName: "One", hasSessionFile: false, createdAt: 0, lastActivity: 0 }, { id: "two", kind: "sub", status: "idle", displayName: "Two", hasSessionFile: false, createdAt: 0, lastActivity: 0 }] } };
	await render(HelpersStatusItem); expect(element.textContent).toBe("1 helper running");
	view = { ...view, mode: "exited" }; await render(HelpersStatusItem); expect(element.textContent).toBe("0 helpers running");
});
it.each([CacheStatusItem, ContextStatusItem, ModelStatusItem, ThinkingStatusItem, QueueStatusItem, WorkingStatusItem, HelpersStatusItem])("omits focused-chat metrics without a focused chat", async component => {
	await render(component, null); expect(element.textContent).toBe("");
});
it("shows omp's cache prediction and removes it immediately when facts become unavailable", async () => {
	view = { ...view, host: { hostId: "host", generation: 1, tspEpoch: 1, transport: "tsp" } } as SessionView;
	fake.snapshot = { hostId: "host", generation: 1, epoch: 1, revision: 1, availability: { available: true, reason: null }, failure: null, negotiated: true, lifecycle: "live", documentGeneration: 1,
		surfaces: [{ documentGeneration: 1, sequence: 1, focus: null, settled: [], closed: false, suspended: false, open: { id: "session", mode: "inline", role: "omp.session" }, document: { id: "root", k: "col", c: [{ id: "dock", k: "col", c: [{ id: "cache", k: "seg", p: { role: "omp.composer.cache", aria: "Cached until 4:53 PM", title: "Cached until 4:53 PM\nNext message reads ~42k from cache" } }] }] } }] } as TspHostSnapshot;
	await render(CacheStatusItem);
	expect(element.textContent).toBe("Cached until 4:53 PM");
	expect(element.querySelector('[aria-label]')?.getAttribute("aria-label")).toBe("Cached until 4:53 PM\nNext message reads ~42k from cache");
	fake.snapshot = null;
	await render(CacheStatusItem); expect(element.textContent).toBe("");
	view = { ...view, host: { ...view.host!, transport: undefined } } as SessionView;
	await render(CacheStatusItem); expect(element.textContent).toBe("");
});
