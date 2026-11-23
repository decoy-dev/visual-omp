// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import { PermissionsSection } from "./PermissionsSection";

const invoke = vi.fn();
let root: Root;
let element: HTMLDivElement;
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	await i18n.loadNamespaces("settings");
	invoke.mockReset();
	Object.assign(window, { vomp: { invoke, on: () => () => {} } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
const section = () => createElement(PermissionsSection, { projectPath: null, scope: "global", setScope: () => {}, props: undefined });
const toolChoices = () => element.querySelectorAll('ul [role="radio"]');

it("shows each tool without a choice until omp reports its permissions, then its real choices", async () => {
	const approval = Promise.withResolvers<unknown>();
	const list = Promise.withResolvers<unknown>();
	invoke.mockImplementation((channel: string) => channel === "config:approval" ? approval.promise : channel === "config:list" ? list.promise : Promise.resolve(undefined));
	await act(async () => root.render(section()));
	expect(element.textContent).toContain("Read files");
	// No Default choice is shown as selected before omp says which choice applies.
	expect(toolChoices()).toHaveLength(0);
	expect(element.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThanOrEqual(3);
	expect(element.textContent).not.toContain("No restricted folders");

	await act(async () => approval.resolve({ cwd: null, mode: "write", modeSource: "global", policies: [{ tool: "bash", policy: "deny", source: "global" }], unrecognized: [] }));
	await act(async () => list.resolve({ settings: [{ key: "tools.restrictedFolders", value: [], globalValue: null, projectValue: null, source: "default" }] }));
	expect(element.querySelector('[aria-busy="true"]')).toBeNull();
	const bash = element.querySelector('[aria-label*="Run commands"]');
	expect(bash?.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("Deny");
	expect(element.textContent).toContain("No restricted folders");
});

it("drops the placeholders when omp cannot report its settings", async () => {
	invoke.mockImplementation((channel: string) => channel === "config:approval" || channel === "config:list" ? Promise.reject(new Error("omp did not answer")) : Promise.resolve(undefined));
	await act(async () => root.render(section()));
	expect(element.querySelector('[aria-busy="true"]')).toBeNull();
	expect(element.querySelector(".vo-skeleton")).toBeNull();
	expect(element.textContent).toContain("omp did not answer");
});
