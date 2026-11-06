// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelperIdentity, HelperTypeIcon, helperActivity } from "./HelperIdentity";
import { SubagentRun, taskRuns } from "../../tool-render/tools/task";
import { i18n } from "../../i18n";

describe("helper identities", () => {
	it("gives built-in types distinct icons and custom definitions a safe default", () => {
		const types = ["task", "scout", "reviewer", "security-reviewer", "designer", "astra", "seance", "sonic", "implementation-plan-drafter"];
		const icons = types.map(agentType => renderToStaticMarkup(h(HelperTypeIcon, { agentType })));
		expect(new Set(icons).size).toBe(types.length);
		const fallback = renderToStaticMarkup(h(HelperTypeIcon));
		for (const agentType of ["custom-project-agent", "constructor", "toString"]) expect(renderToStaticMarkup(h(HelperTypeIcon, { agentType }))).toBe(fallback);
	});

	it.each([
		["read", "files"], ["grep", "files"], ["glob", "files"], ["edit", "writing"], ["write", "writing"], ["ast_edit", "writing"],
		["bash", "commands"], ["eval", "commands"], ["web_search", "web"], ["browser", "web"], ["ask", "question"], ["wait", "waiting"], ["task", "waiting"], [undefined, "thinking"], ["unknown", "thinking"],
	])("shows the current activity for %s", (tool, expected) => expect(helperActivity(tool)).toBe(expected));

	it("keeps type and current tool from task args and progress, including saved results", () => {
		const args = { tasks: [{ name: "Atlas", agent: "scout", task: "Read files" }] };
		expect(taskRuns(args, null, true)[0]).toMatchObject({ agentType: "scout" });
		expect(taskRuns(args, { progress: [{ id: "Atlas", currentTool: "grep" }] }, true)[0]).toMatchObject({ agentType: "scout", currentTool: "grep" });
		expect(taskRuns(args, { results: [{ id: "Atlas", exitCode: 0 }] }, false)[0]).toMatchObject({ agentType: "scout", status: "done" });
		expect(taskRuns({ tasks: [{ name: "Atlas", task: "Work" }] }, null, true)[0]?.agentType).toBe("task");
	});

	it("replaces the activity badge on completion and preserves the helper name and state as text", async () => {
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		await i18n.loadNamespaces("panes");
		const node = document.createElement("div");
		const root = createRoot(node);
		const run = taskRuns({ tasks: [{ name: "Atlas", agent: "scout", task: "Read files" }] }, null, true)[0]!;
		await act(async () => root.render(h(SubagentRun, { run: { ...run, currentTool: "read" } })));
		expect(node.textContent).toContain("Atlas");
		expect(node.textContent).toContain("Working");
		expect(node.querySelector('[data-helper-activity="files"]')?.closest('[aria-hidden="true"]')).not.toBeNull();
		await act(async () => root.render(h(SubagentRun, { run: { ...run, status: "done", currentTool: "read" } })));
		expect(node.textContent).toContain("Done");
		expect(node.querySelector("[data-helper-activity]")).toBeNull();
		expect(renderToStaticMarkup(h(HelperIdentity, { helper: { status: "failed", agentType: "scout" } }))).toContain("text-err");
		await act(async () => root.unmount());
	});
});
