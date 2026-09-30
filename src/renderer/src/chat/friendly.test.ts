import { describe, expect, it } from "vitest";
import tools from "../i18n/en/tools.json";
import { type FriendlySummary, friendlySummary, type ToolCallView } from "./friendly";

function hasKey(path: string): boolean {
	let node: unknown = tools;
	for (const part of path.split(".")) {
		if (typeof node !== "object" || node === null || !(part in node)) return false;
		node = (node as Record<string, unknown>)[part];
	}
	return typeof node === "string";
}

const ok = (details: unknown, isError = false) => ({ content: [{ type: "text", text: "" }], details, isError });

function summarize(call: Partial<ToolCallView> & { name: string }): FriendlySummary {
	const summary = friendlySummary({ args: {}, running: false, ...call });
	expect(hasKey(summary.key), `missing i18n key tools:${summary.key}`).toBe(true);
	return summary;
}

describe("friendlySummary", () => {
	it("counts files and changed lines across a multi-file edit", () => {
		const summary = summarize({
			name: "edit",
			result: ok({
				perFileResults: [
					{ path: "src/cart.ts", diff: "--- a\n+++ b\n@@\n-old\n+new\n+more" },
					{ path: "src/pricing.ts", diff: "@@\n-x\n+y" },
				],
			}),
		});
		expect(summary).toMatchObject({ key: "edit.many.ok", values: { count: 2 }, added: 3, removed: 2, status: "ok" });
	});

	it("names the single file from the hashline header while the edit is still running", () => {
		const summary = summarize({ name: "edit", running: true, args: { input: "[src/cart.ts#1A2B]\nreplace 3" } });
		expect(summary).toMatchObject({ key: "edit.one.running", values: { file: "cart.ts" }, status: "running" });
		expect(summary.added).toBeUndefined();
	});

	it("reports a failing command with its exit code even when the result is not flagged as an error", () => {
		const summary = summarize({ name: "bash", args: { command: "npm test\n--watch" }, result: ok({ exitCode: 2 }) });
		expect(summary).toMatchObject({ key: "bash.failed", values: { command: "npm test", code: 2 }, status: "error" });
	});

	it("shows xd:// device writes as the device tool", () => {
		const summary = summarize({
			name: "write",
			args: { path: "xd://web_search", content: JSON.stringify({ query: "vite 8 release notes" }) },
			result: ok({}),
		});
		expect(summary).toMatchObject({ key: "web.ok", values: { query: "vite 8 release notes" } });
	});

	it("summarizes checklist progress from todo phases", () => {
		const summary = summarize({
			name: "todo",
			result: ok({ phases: [{ tasks: [{ status: "completed" }, { status: "pending" }] }, { tasks: [{ status: "completed" }] }] }),
		});
		expect(summary).toMatchObject({ key: "todo.progress", values: { done: 2, total: 3 } });
	});

	it("detects browser use inside eval and falls back to a generic label for unknown tools", () => {
		expect(summarize({ name: "eval", args: { code: "const tab = await browser.open({})" }, result: ok({}) }).key).toBe("eval.browser.ok");
		expect(summarize({ name: "mcp__linear_create_issue", result: ok({}) })).toMatchObject({
			key: "generic.ok",
			values: { tool: "linear create issue" },
		});
	});
});
