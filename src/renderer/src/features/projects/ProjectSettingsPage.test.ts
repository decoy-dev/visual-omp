// @vitest-environment happy-dom
import { act, createElement as e, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@shared/contracts/config";
import { i18n } from "../../i18n";
import { ProjectSettingsPage } from "./ProjectSettingsPage";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, Set<() => void>>() }));
vi.mock("@/state/app", () => ({ useApp: (select: (state: { projects: [] }) => unknown) => select({ projects: [] }) }));
vi.mock("@/state/navigation", () => ({ usePageBack: () => () => {}, openSettings: vi.fn(), openProjectInstructions: vi.fn() }));
vi.mock("@/ui", () => {
	const children = ({ children }: PropsWithChildren) => children;
	return {
		Button: children, Dialog: () => null, DialogContent: children, Divider: () => null,
		PageFrame: children, PageHeader: () => null, PresenceSwap: children, SectionHeader: () => null,
		Segmented: () => null, Skeleton: () => null, toast: vi.fn(),
	};
});
vi.mock("../manage/roles/ModelSelect", () => ({ ModelSelect: ({ models }: { models: ModelInfo[] }) => e("output", null, JSON.stringify(models)) }));

const oldModel: ModelInfo = {
	selector: "anthropic/claude-fable-5-2", provider: "anthropic", id: "claude-fable-5-2", name: "Claude Fable 5.2",
	kind: "chat", contextWindow: 200_000, maxOutputTokens: null, reasoning: false, thinkingLevels: [], vision: false, cost: null,
};
const currentModel: ModelInfo = { ...oldModel, contextWindow: 1_000_000, reasoning: true, thinkingLevels: ["high"], vision: true };
let catalog: ModelInfo[] | Promise<ModelInfo[]>;
let root: Root;
let element: HTMLDivElement;
async function changed(channel: string) {
	await act(async () => { for (const listener of fake.listeners.get(channel) ?? []) listener(); });
}
beforeAll(async () => { await i18n.loadNamespaces("projectDetails"); });
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.listeners.clear(); fake.invoke.mockReset(); catalog = [oldModel];
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "config:models") return catalog;
		if (channel === "config:roles") return { roles: [{ id: "default", acceptsKinds: ["chat"], projectValue: null, globalValue: null }] };
		if (channel === "config:approval") return { mode: "write", modeSource: "global", policies: [], unrecognized: [] };
		return undefined;
	});
	Object.assign(window, { vomp: { invoke: fake.invoke, on: (channel: string, listener: () => void) => {
		const listeners = fake.listeners.get(channel) ?? new Set(); listeners.add(listener); fake.listeners.set(channel, listeners);
		return () => listeners.delete(listener);
	} } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

describe("project settings catalog refresh", () => {
	it.each(["resolve", "reject"] as const)("keeps current metadata when a pre-update request later %ss", async outcome => {
		await act(async () => root.render(e(ProjectSettingsPage, { props: { projectPath: "/fixture/project" }, seq: 1, close: () => {} })));
		expect(element.querySelector("output")?.textContent).toContain('"reasoning":false');
		const stale = Promise.withResolvers<ModelInfo[]>();
		catalog = stale.promise;
		await changed("config:changed");
		catalog = [currentModel];
		await changed("omp:status");
		expect(element.querySelector("output")?.textContent).toContain('"contextWindow":1000000');
		await act(async () => {
			if (outcome === "resolve") stale.resolve([oldModel]);
			else stale.reject(new Error("Obsolete project catalog failed"));
		});
		expect(element.querySelector("output")?.textContent).toContain('"reasoning":true');
		expect(element.textContent).not.toContain("Obsolete project catalog failed");
	});
});
