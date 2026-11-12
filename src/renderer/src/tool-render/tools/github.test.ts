// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getGithubStepProgress, getGithubStepTone, githubRenderer } from "./github";

function renderJob(status?: string, conclusion?: string, steps?: unknown): HTMLElement {
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
							...(steps === undefined ? {} : { steps }),
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

describe("GitHub run-watch step progress", () => {
	it("labels the in-progress step and uses its state tone", () => {
		const progress = getGithubStepProgress([
			{ number: 1, name: "Checkout", conclusion: "success" },
			{ number: 3, name: "Run tests", status: "in_progress" },
			{ number: 4, name: "Upload", status: "queued" },
		]);
		expect(progress?.label).toBe("2/3 #3 Run tests · in progress");
		expect(progress?.tone).toBe("warning");
	});

	it("labels the next pending step when none is running", () => {
		const progress = getGithubStepProgress([
			{ number: 1, name: "Checkout", conclusion: "success" },
			{ number: 2, name: "Build", status: "queued" },
		]);
		expect(progress?.label).toBe("2/2 #2 Build · queued");
		expect(progress?.tone).toBe("muted");
	});

	it("labels the first failed step with completed progress", () => {
		const progress = getGithubStepProgress([
			{ number: 1, name: "Checkout", conclusion: "success" },
			{ number: 2, name: "Lint", status: "completed", conclusion: "failure" },
			{ number: 3, name: "Tests", status: "queued" },
		]);
		expect(progress?.label).toBe("#2 Lint · failure · 2/3");
		expect(progress?.tone).toBe("error");
	});

	it("labels all successful steps as complete", () => {
		const progress = getGithubStepProgress([
			{ number: 1, name: "Checkout", conclusion: "success" },
			{ number: 2, name: "Build", status: "completed", conclusion: "success" },
		]);
		expect(progress?.label).toBe("2/2 steps complete");
		expect(progress?.tone).toBe("success");
	});

	it("keeps unknown states visible with a muted tone", () => {
		const progress = getGithubStepProgress([{ number: 1, name: "Verify", status: "new_state" }]);
		expect(progress?.label).toBe("0/1 steps complete");
		expect(getGithubStepTone({ number: 1, name: "Verify", status: "new_state" })).toBe("muted");
		expect(getGithubStepTone({ number: 1, name: "Verify", conclusion: "new_conclusion" })).toBe("muted");
		const row = renderJob(undefined, undefined, [{ number: 1, name: "Verify", status: "new_state" }]);
		const unknownState = row.parentElement?.querySelector(".tv-gh-step span.tv-muted:last-child");
		expect(unknownState?.textContent).toBe("new state");
	});

	it("treats states named like Object properties as unknown", () => {
		expect(getGithubStepTone({ number: 1, name: "Verify", conclusion: "constructor" })).toBe("muted");
		expect(getGithubStepTone({ number: 1, name: "Verify", status: "toString" })).toBe("muted");
		expect(getGithubStepProgress([{ number: 1, name: "Verify", status: "constructor" }])?.label).toBe("0/1 steps complete");
	});

	it("skips malformed steps and ignores malformed optional fields", () => {
		const progress = getGithubStepProgress([
			null,
			{ name: "No number" },
			{ number: 2, name: 4 },
			{ number: 3, name: "Build", status: 4, conclusion: null, durationSeconds: "12" },
		]);
		expect(progress?.steps).toEqual([{ number: 3, name: "Build" }]);
		expect(progress?.label).toBe("0/1 steps complete");
		expect(getGithubStepProgress([{ number: "1", name: "Malformed" }])).toBeUndefined();
	});

	it("keeps jobs without steps in the existing job-row shape", () => {
		const row = renderJob("in_progress");
		expect(row.textContent).toContain("Test (macOS) 12s");
		expect(row.parentElement?.querySelector(".tv-gh-steps")).toBeNull();
		expect(row.parentElement?.textContent).not.toContain("steps complete");
	});

	it("shows ordered steps behind a closed disclosure", () => {
		const row = renderJob(undefined, undefined, [
			{ number: 1, name: "Checkout", conclusion: "success", durationSeconds: 2 },
			{ number: 2, name: "Run tests", status: "in_progress" },
		]);
		const disclosure = row.parentElement?.querySelector("details.tv-gh-steps");
		expect(disclosure?.hasAttribute("open")).toBe(false);
		expect(disclosure?.textContent).toContain("#1 Checkout success 2s");
		expect(disclosure?.textContent).toContain("#2 Run tests in progress");
	});
});
