// @vitest-environment happy-dom
import { act, createElement as e } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ConfigChangedEvent, ConfigSnapshot, JsonValue, SettingInfo } from "@shared/contracts/config";
import type { SkillEntry } from "@shared/contracts/skills";
import { i18n } from "@/i18n";
import { TooltipProvider } from "@/ui";
import { ManualSkills } from "./ManualSkills";
import { SkillsTab } from "./SkillsTab";

vi.mock("./SkillDrawer", () => ({ SkillDrawer: () => null }));
const env = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, Set<(event: ConfigChangedEvent) => void>>() }));
let setting: SettingInfo | null;
let fail = false;
let projectManual = false;
let root: Root;
let element: HTMLDivElement;
const makeSetting = (value: JsonValue): SettingInfo => ({ key: "skills.manualSkills", namespace: "skills", type: "array", description: "", enumValues: null, value, defaultValue: [], globalValue: value, projectValue: null, source: "global", redacted: false, modified: true });
const snapshot = (): ConfigSnapshot => ({ cwd: null, agentDir: "/fixture/agent", globalFile: "/fixture/config.yml", projectFile: null, settings: setting ? [setting] : [] });
const skills = (): SkillEntry[] => [false, true].map((hidden, index) => ({ name: index ? "unmatched-but-hidden" : "docs-visible", description: "Fixture skill", filePath: `/fixture/${index}/SKILL.md`, baseDir: `/fixture/${index}`, provider: "native", level: "user", source: "native:user", hidden: hidden || projectManual, enabled: true, disabledReason: null, toggleName: String(index), registry: null, issues: [], warnings: [] }));
const mount = async (tab = false) => {
	await act(async () => root.render(e(TooltipProvider, { children: tab ? e(SkillsTab, { cwd: "/fixture/project", projectPath: "/fixture/project", filter: "installed", query: "", onBrowse: () => {} }) : e(ManualSkills) })));
};
const button = (name: string) => [...element.querySelectorAll("button")].find(button => (button.getAttribute("aria-label") ?? button.textContent) === name)!;
const input = () => element.querySelector<HTMLInputElement>('input[placeholder="docs-*"]')!;
const enter = async (text: string) => {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
		input().dispatchEvent(new Event("input", { bubbles: true }));
	});
};
const changed = async (event: ConfigChangedEvent = { scope: "global", cwd: null, file: "/fixture/config.yml" }) => { await act(async () => { for (const listener of env.listeners.get("config:changed") ?? []) listener(event); }); };

beforeAll(async () => { await i18n.loadNamespaces(["context", "settings"]); });
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	setting = makeSetting(["docs-*"]); fail = false;
	projectManual = false;
	env.listeners.clear(); env.invoke.mockReset();
	env.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
		if (channel === "config:list") return snapshot();
		if (channel === "config:set") {
			if (fail) throw new Error("Fixture write refused");
			setting = makeSetting(args[1] as JsonValue);
			for (const listener of env.listeners.get("config:changed") ?? []) listener({ scope: "global", cwd: null, file: "/fixture/config.yml", origin: "app" });
			return { setting, shadowedBy: null };
		}
		if (channel === "skills:list") return { cwd: "/fixture/project", projectScopeAvailable: true, skillsEnabled: true, skills: skills(), invalid: [], warnings: [] };
		if (channel === "skills:registry:installed") return [];
	});
	Object.assign(window, { vomp: { platform: "darwin", invoke: env.invoke, on: (channel: string, listener: (event: ConfigChangedEvent) => void) => { const listeners = env.listeners.get(channel) ?? new Set(); listeners.add(listener); env.listeners.set(channel, listeners); return () => listeners.delete(listener); } } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

it("adds and removes glob patterns through omp's global settings without matching them", async () => {
	await mount();
	expect(element.textContent).toContain("docs-*");
	await enter("  ops/**  ");
	await act(async () => button("Add pattern").click());
	expect(env.invoke).toHaveBeenCalledWith("config:set", "skills.manualSkills", ["docs-*", "ops/**"], "global", undefined);
	expect(input().value).toBe("");
	await act(async () => button("Remove pattern docs-*").click());
	await act(async () => button("Remove pattern ops/**").click());
	expect(setting?.value).toEqual([]);
	expect(element.textContent).toContain("No manual-only patterns are configured.");
});
it("retains a failed addition for retry and does not remove saved entries after a refused write", async () => {
	await mount(); fail = true;
	await enter("ops-*");
	await act(async () => button("Add pattern").click());
	expect(input().value).toBe("ops-*");
	await act(async () => button("Remove pattern docs-*").click());
	expect(button("Remove pattern docs-*")).toBeDefined();
	fail = false;
	await act(async () => button("Add pattern").click());
	expect(setting?.value).toEqual(["docs-*", "ops-*"]);
});
it("explains unsupported omp without offering writes", async () => {
	setting = null; await mount();
	expect(element.textContent).toContain("does not report skills.manualSkills");
	expect(element.querySelector("input")).toBeNull();
	expect(env.invoke.mock.calls.some(([channel]) => channel === "config:set")).toBe(false);
});
it("keeps higher-priority effective patterns separate and refreshes external changes", async () => {
	setting = { ...makeSetting(["global-*"]), value: ["env-*"], source: "env" };
	await mount();
	expect(button("Remove pattern global-*")).toBeDefined();
	expect(button("Remove pattern env-*")).toBeUndefined();
	expect(element.textContent).toContain('different effective list: ["env-*"]');
	setting = makeSetting(["external-*"]); await changed();
	expect(button("Remove pattern external-*")).toBeDefined();
});
it("marks manual-only rows exclusively from omp's hide flag and reloads them on config changes", async () => {
	await mount(true);
	const rows = [...element.querySelectorAll("li")].filter(row => row.textContent?.includes("Fixture skill"));
	expect(rows).toHaveLength(2);
	expect(rows[0]!.textContent).not.toContain("Manual only");
	expect(rows[1]!.textContent).toContain("Manual only");
	const loads = env.invoke.mock.calls.filter(([channel]) => channel === "skills:list").length;
	await changed();
	expect(env.invoke.mock.calls.filter(([channel]) => channel === "skills:list")).toHaveLength(loads + 1);
	await act(async () => button("Remove pattern docs-*").click());
	expect(env.invoke.mock.calls.filter(([channel]) => channel === "skills:list")).toHaveLength(loads + 2);
});

it("watches the displayed project's config, refreshes its manual-only labels, and releases both watchers", async () => {
	await mount(true);
	expect(env.invoke).toHaveBeenCalledWith("config:watch", "/fixture/project");
	expect(env.invoke).toHaveBeenCalledWith("config:watch");
	const loads = env.invoke.mock.calls.filter(([channel]) => channel === "skills:list").length;
	projectManual = true;
	await changed({ scope: "project", cwd: "/fixture/other", file: "/fixture/other/.omp/config.yml" });
	expect(env.invoke.mock.calls.filter(([channel]) => channel === "skills:list")).toHaveLength(loads);
	await changed({ scope: "project", cwd: "/fixture/project", file: "/fixture/project/.omp/config.yml" });
	expect(env.invoke.mock.calls.filter(([channel]) => channel === "skills:list")).toHaveLength(loads + 1);
	const row = [...element.querySelectorAll("li")].find(row => row.textContent?.includes("docs-visible"));
	expect(row?.textContent).toContain("Manual only");
	await act(async () => root.render(null));
	expect(env.invoke).toHaveBeenCalledWith("config:unwatch", "/fixture/project");
	expect(env.invoke).toHaveBeenCalledWith("config:unwatch");
	expect(env.listeners.get("config:changed")?.size).toBe(0);
});
