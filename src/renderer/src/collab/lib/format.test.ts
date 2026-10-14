import { describe, expect, it } from "vitest";
import { fmtDuration } from "./format";

describe("fmtDuration", () => {
	it("keeps subsecond precision and rounds before splitting minutes", () => {
		expect(fmtDuration(110)).toBe("110ms");
		expect(fmtDuration(4_210)).toBe("4.2s");
		expect(fmtDuration(9_960)).toBe("10s");
		expect(fmtDuration(59_600)).toBe("1m 00s");
		expect(fmtDuration(119_600)).toBe("2m 00s");
		expect(fmtDuration(161_000)).toBe("2m 41s");
		expect(fmtDuration(4_380_000)).toBe("1h 13m");
	});

	it("never invents a duration from a negative or broken value", () => {
		expect(fmtDuration(-5)).toBe("0ms");
		expect(fmtDuration(Number.NaN)).toBe("0ms");
	});
});
