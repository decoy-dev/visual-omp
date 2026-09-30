import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deltaTags, deltaTitle, parseSharpshooterDelta, SharpshooterStateSchema } from "./sharpshooter";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("sharpshooter queue delta", () => {
	it("parses a queued delta with its provenance and friction", () => {
		const delta = parseSharpshooterDelta(fixture("sharpshooter-delta.json"));
		expect(delta).toMatchObject({ kind: "style_decision", sessionId: "sess-alpha", ts: 1790789000000 });
		expect(delta && deltaTitle(delta.kind)).toBe("Style decision");
		expect(delta && deltaTags(delta)).toEqual(["style_decision", "explicit_user", "corrective", "subtle"]);
	});

	it("skips torn or foreign queue files like omp does", () => {
		expect(parseSharpshooterDelta('{"v":1,"kind":"style_decision"')).toBeNull();
		expect(parseSharpshooterDelta(JSON.stringify({ ...JSON.parse(fixture("sharpshooter-delta.json")), v: 2 }))).toBeNull();
	});
});

describe("sharpshooter state.json", () => {
	it("parses consolidation bookkeeping", () => {
		expect(SharpshooterStateSchema.parse(JSON.parse(fixture("sharpshooter-state.json")))).toEqual({
			v: 1,
			lastConsolidatedAt: 1790780000000,
			lastResult: { at: 1790780000000, sessions: 1, deltas: 2, model: "anthropic/claude-haiku" },
		});
	});
});
