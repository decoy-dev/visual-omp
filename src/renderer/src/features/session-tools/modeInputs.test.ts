import { describe, expect, it } from "vitest";
import { goalBudget, loopRequest } from "./modeInputs";
import { statusWithModes } from "./status";

describe("native mode inputs", () => {
	it("preserves goal budgets without a separate typed budget command", () => {
		expect(goalBudget("100k")).toBe(100000);
		expect(goalBudget("1.5m")).toBe(1500000);
		expect(goalBudget("")).toBeUndefined();
		expect(() => goalBudget("0")).toThrow();
	});
	it("constructs loop conditions as data without shell quoting a mode command", () => {
		expect(loopRequest("until", "", "test \"$value\" = 'done'", "repeat task")).toEqual({ mode: "loop", action: "enter", prompt: "repeat task", condition: { command: "test \"$value\" = 'done'", until: true } });
		expect(loopRequest("duration", "1h30m", "", "")).toMatchObject({ limit: { kind: "duration", durationMs: 5400000 } });
		expect(loopRequest("count", "5", "", "")).toMatchObject({ limit: { kind: "iterations", iterations: 5 } });
		expect(() => loopRequest("duration", "10x", "", "")).toThrow();
	});
	it("reads all mode states while the editor is hidden", () => {
		expect(statusWithModes(null, { plan: { status: "paused" }, goal: { status: "active" }, vibe: { status: "inactive" }, loop: { status: "paused" } })).toEqual({ model: null, thinking: null, plan: "paused", goal: "active", vibe: false, loop: true });
	});
});
