// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { githubRenderer } from "./github";

function renderJob(status?: string, conclusion?: string): HTMLElement {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(createElement(githubRenderer.Body!, {
		name: "github",
		args: { op: "run_watch", run: "19758042", repo: "decoy-dev/visual-omp" },
		running: true,
		result: {
			content: [],
			details: {
				watch: {
					mode: "run", state: "watching", repo: "decoy-dev/visual-omp", pollCount: 2,
					run: {
						id: 19758042, workflowName: "CI", displayTitle: "Check renderer", branch: "main",
						status: "in_progress", headSha: "0123456789abcdef0123456789abcdef01234567",
						jobs: [{ id: 58362901, name: "Test (macOS)", status, conclusion, durationSeconds: 12,
							url: "https://github.com/decoy-dev/visual-omp/actions/runs/19758042/job/58362901" }],
					},
				},
			},
		},
	}));
	return [...container.querySelectorAll<HTMLElement>(".tv-row")].find(row => row.textContent?.includes("Test (macOS)"))!;
}

describe("GitHub run-watch job states", () => {
	it.each(["queued", "requested", "waiting", "pending"])("labels %s jobs as pending with a distinct shape", status => {
		const row = renderJob(status);
		const visual = row.querySelector('[role="img"][aria-label="Pending"]');
		expect(visual).not.toBeNull();
		expect(visual?.querySelector("svg")).not.toBeNull();
		expect(visual?.classList.contains("tv-muted")).toBe(true);
		expect(row.textContent).toContain("Test (macOS)");
		expect(row.textContent).toContain("12s");
	});

	it.each([
		["completed", "success", "Succeeded", "✓"],
		["completed", "neutral", "Neutral", "✓"],
		["completed", "skipped", "Skipped", "✓"],
		["completed", "failure", "Failed", "✕"],
		["completed", "timed_out", "Timed out", "✕"],
		["completed", "cancelled", "Cancelled", "✕"],
		["completed", "action_required", "Action required", "✕"],
		["completed", "startup_failure", "Startup failure", "✕"],
		["in_progress", undefined, "Running", "●"],
		["completed", "new_conclusion", "Unknown status", "○"],
		["new_status", undefined, "Unknown status", "○"],
		[undefined, undefined, "Unknown status", "○"],
	])("keeps %s / %s distinct from pending", (status, conclusion, label, icon) => {
		const visual = renderJob(status, conclusion).querySelector(`[role="img"][aria-label="${label}"]`);
		expect(visual?.textContent).toBe(icon);
	});

	it.each([["success", "Succeeded"], ["failure", "Failed"]])("lets the %s conclusion take precedence over a stale queued status", (conclusion, label) => {
		expect(renderJob("queued", conclusion).querySelector(`[aria-label="${label}"]`)).not.toBeNull();
	});
});
